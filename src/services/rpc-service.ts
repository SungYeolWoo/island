// cls should be placed on top
import * as cls from 'continuation-local-storage';

import * as amqp from 'amqplib';
import * as Bluebird from 'bluebird';
import deprecated from 'deprecated-decorator';
import * as _ from 'lodash';
import * as os from 'os';
import uuid = require('uuid');

import { RpcOptions } from '../controllers/rpc-decorator';
import { sanitize, validate } from '../middleware/schema.middleware';
import { Environments } from '../utils/environments';
import { AbstractError, FatalError, ISLAND, LogicError, mergeIslandJsError } from '../utils/error';
import { logger } from '../utils/logger';
import { RouteLogger } from '../utils/route-logger';
import reviver from '../utils/reviver';
import { RpcRequest } from '../utils/rpc-request';
import { IRpcResponse, RpcResponse } from '../utils/rpc-response';
import { collector } from '../utils/status-collector';
import { AmqpChannelPoolService } from './amqp-channel-pool-service';

export { IRpcResponse, RpcRequest, RpcResponse };

const RPC_EXEC_TIMEOUT_MS = Environments.getIslandRpcExecTimeoutMs();
const RPC_WAIT_TIMEOUT_MS = Environments.getIslandRpcWaitTimeoutMs();
const SERVICE_LOAD_TIME_MS = Environments.getIslandServiceLoadTimeMs();
const RPC_RES_NOACK = Environments.isIslandRpcResNoack();
const RPC_QUEUE_EXPIRES_MS = RPC_WAIT_TIMEOUT_MS + SERVICE_LOAD_TIME_MS;
const NO_REVIVER = Environments.isNoReviver();
const RPC_QUEUE_DISTRIB_SIZE = 16;

export type RpcType = 'rpc' | 'endpoint';
export interface IConsumerInfo {
  channel: amqp.Channel;
  tag: string;
  options?: RpcOptions;
  key: string;
  consumer: (msg: any) => Promise<void>;
  consumerOpts?: any;
}

interface Message {
  content: Buffer;
  fields: {[key: string]: any; exchange: string};
  properties: amqp.Options.Publish;
}

export type RpcHook = (rpc) => Promise<any>;
export enum RpcHookType {
  PRE_ENDPOINT,
  POST_ENDPOINT,
  PRE_RPC,
  POST_RPC,
  PRE_ENDPOINT_ERROR,
  POST_ENDPOINT_ERROR,
  PRE_RPC_ERROR,
  POST_RPC_ERROR
}

export interface RpcEntities {
    [rpcName: string]: {
      handler: (req: any) => Promise<any>;
      type: RpcType;
      rpcOptions?: RpcOptions;
    };
}

export interface InitializeOptions {
  noReviver?: boolean;
  consumerAmqpChannelPool?: AmqpChannelPoolService;
}

function sanitizeAndValidate(content, rpcOptions) {
  if (rpcOptions) {
    if (_.get(rpcOptions, 'schema.query.sanitization')) {
      content = sanitize(rpcOptions.schema!.query!.sanitization, content);
    }
    if (_.get(rpcOptions, 'schema.query.validation')) {
      if (!validate(rpcOptions.schema!.query!.validation, content)) {
        throw new LogicError(ISLAND.LOGIC.L0002_WRONG_PARAMETER_SCHEMA, `Wrong parameter schema`);
      }
    }
  }
  return content;
}

function sanitizeAndValidateResult(res, rpcOptions?: RpcOptions) {
  if (!rpcOptions) return res;
  if (_.get(rpcOptions, 'schema.result.sanitization')) {
    res = sanitize(rpcOptions.schema!.result!.sanitization, res);
  }
  if (_.get(rpcOptions, 'schema.result.validation')) {
    validate(rpcOptions.schema!.result!.validation, res);
  }
  return res;
}

function nackWithDelay(channel, msg) {
  setTimeout(() => channel.nack(msg), 1000) as any;
}

type DeferredResponse = { resolve: (msg: Message) => any, reject: (e: Error) => any };

export default class RPCService {
  private requestConsumerInfo: IConsumerInfo[] = [];
  private responseQueueName: string;
  private waitingResponse: { [corrId: string]: DeferredResponse } = {};
  private timedOut: { [corrId: string]: string } = {};
  private timedOutOrdered: string[] = [];
  private channelPool: AmqpChannelPoolService;
  private consumerChannelPool: AmqpChannelPoolService;
  private serviceName: string;
  private hooks: { [key: string]: RpcHook[] };
  private onGoingRequest: {
      count: number, details: Map<string, number>
    } = { count : 0, details : new Map() };
  private purging: Function | null = null;
  private rpcEntities: RpcEntities = {};

  constructor(serviceName?: string) {
    this.serviceName = serviceName || 'unknown';
    this.hooks = {};
  }

  public async initialize(channelPool: AmqpChannelPoolService, opts?: InitializeOptions): Promise<any> {
    if (NO_REVIVER || opts && opts.noReviver) {
      RpcResponse.reviver = undefined;
    } else {
      RpcResponse.reviver = reviver;
    }
    if (opts && opts.consumerAmqpChannelPool) {
      this.consumerChannelPool = opts.consumerAmqpChannelPool;
      logger.info(`pub/sub channelPool connection splitted`);
    } else {
      this.consumerChannelPool = channelPool;
    }
    this.responseQueueName = this.makeResponseQueueName();
    logger.info(`consuming ${this.responseQueueName}`);

    this.channelPool = channelPool;
    await this.consumerChannelPool.usingChannel(
      channel => channel.assertQueue(this.responseQueueName, {
        durable: false, exclusive: true, expires: RPC_QUEUE_EXPIRES_MS
      })
    );

    await this.consumeForResponse();
  }

  @deprecated()
  public _publish(exchange: any, routingKey: any, content: any, options?: any) {
    return this.channelPool.usingChannel(channel => {
      return Promise.resolve(channel.publish(exchange, routingKey, content, options));
    });
  }

  public async purge() {
    logger.info('stop serving');
    await this.unregisterAll();

    let precondition = Promise.resolve();
    if (0 < this.onGoingRequest.count) {
      precondition = new Promise<void>(res => this.purging = res);
    }
    await precondition;

    this.hooks = {};
    this.timedOut = {};
    this.timedOutOrdered = [];
  }

  public async sigInfo() {
    logger.info(`RPC Service onGoingRequestCount : ${this.onGoingRequest.count}`);
    this.onGoingRequest.details.forEach((v, k) => {
      if (v < 1) return;
      logger.info(`RPC Service ${k} : ${v}`);
    });
  }

  public registerHook(type: RpcHookType, hook: RpcHook) {
    this.hooks[type] = this.hooks[type] || [];
    this.hooks[type].push(hook);
  }

  public async register(rpcName: string,
                        handler: (req: any) => Promise<any>,
                        type: RpcType,
                        rpcOptions?: RpcOptions): Promise<void> {
    this.rpcEntities[rpcName] = { handler, type, rpcOptions };
  }

  public async listen() {
    const queues = _.map(_.range(RPC_QUEUE_DISTRIB_SIZE), no => (`rpc.req.${this.serviceName}.${no}`));
    await this.assertQueues(queues);
    await this.assertExchanges(this.rpcEntities);
    await this.bindQueuesToExchanges(queues, this.rpcEntities);
    await this.startConsumingQueues(queues);
  }

  @deprecated()
  public async pause(name: string) {
    logger.warning('RPCService no longer supports to pause a specific RPC', name);
  }

  public async pauseAll() {
    if (this.requestConsumerInfo.length === 0) return;
    await Promise.all(this.requestConsumerInfo.map(ci => ci.channel.cancel(ci.tag)));
  }

  @deprecated()
  public async resume(name: string) {
    logger.warning('RPCService no longer supports to resume a specific RPC', name);
  }

  public async resumeAll() {
    if (this.requestConsumerInfo.length === 0) return;
    await Promise.all(this.requestConsumerInfo.map(ci => ci.channel.consume(ci.key, ci.consumer)));
  }

  @deprecated()
  public async unregister(name: string) {
    logger.warning('RPCService no longer supports to unregister a specific RPC', name);
  }

  public async unregisterAll() {
    if (this.requestConsumerInfo.length === 0) return;
    await Promise.all(this.requestConsumerInfo.map(async ci => {
      try {
        await ci.channel.cancel(ci.tag);
      } catch (e) {
        // ignore against an already closed channel
      }
    }));
    this.requestConsumerInfo = [];
    this.rpcEntities = {};
  }

  public async invoke<T, U>(name: string, msg: T, opts?: {withRawdata: boolean}): Promise<U>;
  public async invoke(name: string, msg: any, opts?: {withRawdata: boolean}): Promise<any> {
    const option = this.makeInvokeOption(name);
    const p = this.waitResponse(option.correlationId!, (msg: Message) => {
      RouteLogger.replaceLogs('app', msg.properties.headers.extra.routeLogs);
      const res = RpcResponse.decode(msg.content);
      if (res.result === false) throw res.body;
      if (opts && opts.withRawdata) return { body: res.body, raw: msg.content };
      return res.body;
    })
      .timeout(RPC_WAIT_TIMEOUT_MS)
      .catch(Bluebird.TimeoutError, () => this.throwTimeout(name, option.correlationId!))
      .catch(err => {
        err.tattoo = option.headers.tattoo;
        throw err;
      });

    const content = new Buffer(JSON.stringify(msg), 'utf8');
    try {
      const routingKey = '' + _.random(0, RPC_QUEUE_DISTRIB_SIZE - 1);
      await this.channelPool.usingChannel(async chan => chan.publish(name, routingKey, content, option));
    } catch (e) {
      this.waitingResponse[option.correlationId!].reject(e);
      delete this.waitingResponse[option.correlationId!];
    }
    return await p;
  }

  // There are two kind of consumes - get requested / get a response
  // * get-requested consumers can be multiple per a node and they shares a RPC queue between island nodes
  // * get-a-response consumer is only one per a node and it has an exclusive queue
  protected async _consume(key: string, handler: (msg) => Promise<any>, noAck?: boolean): Promise<IConsumerInfo> {
    const channel = await this.consumerChannelPool.acquireChannel();
    const prefetchCount = await this.consumerChannelPool.getPrefetchCount();
    noAck = noAck || false;
    await channel.prefetch(prefetchCount || Environments.getRpcPrefetch());

    const consumer = async msg => {
      try {
        await handler(msg);
        if (!noAck) channel.ack(msg);
      } catch (error) {
        if (this.is503(error)) return nackWithDelay(channel, msg);
        if (this.isCritical(error)) return this.shutdown();
        if (!noAck) channel.ack(msg);
      }
    };
    const opts = {
      consumerTag: [this.serviceName, os.hostname(), key].join('.')
    } as amqp.Options.Consume;
    if (noAck) {
      opts.noAck = noAck;
    }
    const result = await channel.consume(key, consumer, opts);
    return { channel, tag: result.consumerTag, key, consumer };
  }

  private throwTimeout(name, corrId: string) {
    delete this.waitingResponse[corrId];
    this.timedOut[corrId] = name;
    this.timedOutOrdered.push(corrId);
    if (20 < this.timedOutOrdered.length) {
      delete this.timedOut[this.timedOutOrdered.shift()!];
    }
    const err = new FatalError(ISLAND.FATAL.F0023_RPC_TIMEOUT,
                               `RPC(${name}) does not return in ${RPC_WAIT_TIMEOUT_MS} ms`);
    err.statusCode = 504;
    throw err;
  }

  private shutdown() {
    process.emit('SIGTERM');
  }

  private makeResponseQueueName() {
    // NOTE: live docker 환경에서는 같은 hostname + process.pid 조합이 유일하지 않을 수 있다
    // docker 내부의 process id 는 1인 경우가 대부분이며 host=net으로 실행시키는 경우 hostname도 동일할 수 있다.
    return `rpc.res.${this.serviceName}.${os.hostname()}.${uuid.v4()}`;
  }

  private consumeForResponse() {
    return this._consume(this.responseQueueName, (msg: Message | null) => {
      if (!msg) {
        logger.crit(`The consumer is canceled, will lose following responses - https://goo.gl/HIgy4D`);
        throw new FatalError(ISLAND.FATAL.F0027_CONSUMER_IS_CANCELED);
      }
      const correlationId = msg.properties.correlationId;
      if (!correlationId) {
        logger.notice('Got a response with no correlationId');
        return;
      }
      if (this.timedOut[correlationId]) {
        const name = this.timedOut[correlationId];
        delete this.timedOut[correlationId];
        _.pull(this.timedOutOrdered, correlationId);

        logger.warning(`Got a response of \`${name}\` after timed out - ${correlationId}`);
        return;
      }
      const waiting = this.waitingResponse[correlationId];
      if (!waiting) {
        logger.notice(`Got an unknown response - ${correlationId}`);
        return;
      }
      delete this.waitingResponse[correlationId];
      return waiting.resolve(msg);
    }, RPC_RES_NOACK);
  }

  private waitResponse(corrId: string, handleResponse: (msg: Message) => any) {
    return new Bluebird((resolve, reject) => {
      this.waitingResponse[corrId] = { resolve, reject };
    }).then((msg: Message) => {
      const clsScoped = cls.getNamespace('app').bind((msg: Message) => {
        delete this.waitingResponse[corrId];
        return handleResponse(msg);
      });
      return clsScoped(msg);
    });
  }

  private makeInvokeOption(name: string): amqp.Options.Publish {
    const correlationId = uuid.v4();
    RouteLogger.saveLog({ clsNameSpace: 'app', context: name, type: 'req', protocol: 'RPC', correlationId });
    return {
      correlationId,
      expiration: RPC_WAIT_TIMEOUT_MS,
      headers: this.getHeader(),
      replyTo: this.responseQueueName,
      timestamp: +(new Date())
    };
  }

  private getHeader(): any {
    const ns = cls.getNamespace('app');
    return {
      tattoo: ns.get('RequestTrackId'),
      from: {
        node: Environments.getHostName(),
        context: ns.get('Context'),
        island: this.serviceName,
        type: ns.get('Type')
      },
      extra: { 
        sessionType: ns.get('sessionType'), 
        routeLogs: RouteLogger.getLogs('app')
      }
    };
  }

  // 503(Service Temporarily Unavailable) 오류일 때는 응답을 caller에게 안보내줘야함
  private async earlyThrowWith503(rpcName, err, msg) {
    // Requeue the message when it has a chance
    if (this.is503(err)) throw err;
    return err;
  }

  private is503(err) {
    return err.statusCode && parseInt(err.statusCode, 10) === 503;
  }

  private isCritical(err) {
    return err.code === mergeIslandJsError(ISLAND.FATAL.F0027_CONSUMER_IS_CANCELED);
  }

  private logRpcError(err) {
    logger.error(`Got an error during ${err.extra.island}/${err.extra.rpcName}` +
      ` with ${JSON.stringify(err.extra.req)} - ${err.stack}`);
  }

  private attachExtraError(err: AbstractError, rpcName: string, req: any) {
    err.extra = _.defaults({}, err.extra, { island: this.serviceName, rpcName, req });
    err.extra = AbstractError.ensureUuid(err.extra);
    return err;
  }

  // returns value again for convenience
  private async reply(replyTo: string, value: any, options: amqp.Options.Publish) {
    options.headers = this.getOptionsHeader(options);

    await this.channelPool.usingChannel(async channel => {
      return channel.sendToQueue(replyTo, RpcResponse.encode(value), options);
    });
    return value;
  }

  private getOptionsHeader(options: amqp.Options.Publish) {
    const ns = cls.getNamespace('app');
    RouteLogger.saveLog({ clsNameSpace: 'app', context: ns.get('Context'), type: 'res', protocol: 'RPC', correlationId: options.correlationId || ''});
    RouteLogger.print('app');
    options.headers.extra.routeLogs = RouteLogger.getLogs('app');

    return options.headers;
  }

  // enter continuation-local-storage scope
  private enterCLS(tattoo, rpcName, extra, func) {
    const properties = _.merge({ RequestTrackId: tattoo, Context: rpcName, Type: 'rpc' }, extra);
    return new Promise((resolve, reject) => {
      const ns = cls.getNamespace('app');
      ns.run(() => {
        _.each(properties, (value, key: string) => {
          ns.set(key, value);
        });
        Bluebird.try(func).then(resolve).catch(reject);
      });
    });
  }

  private async dohook(prefix: 'pre' | 'post' | 'pre-error' | 'post-error', type: 'endpoint' | 'rpc', value) {
    const hookType = {
      endpoint: {
        pre: RpcHookType.PRE_ENDPOINT, post: RpcHookType.POST_ENDPOINT,
        'pre-error': RpcHookType.PRE_ENDPOINT_ERROR, 'post-error': RpcHookType.POST_ENDPOINT_ERROR
      },
      rpc: {
        pre: RpcHookType.PRE_RPC, post: RpcHookType.POST_RPC,
        'pre-error': RpcHookType.PRE_RPC_ERROR, 'post-error': RpcHookType.POST_RPC_ERROR
      }
    }[type][prefix];
    const hook = this.hooks[hookType];
    if (!hook) return value;
    return Bluebird.reduce(this.hooks[hookType], (value, hook) => hook(value), value);
  }

  private increaseRequest(name: string, count: number) {
    this.onGoingRequest.count += count;
    const requestCount = (this.onGoingRequest.details.get(name) || 0) + count;
    this.onGoingRequest.details.set(name, requestCount);
  }

  private async assertQueues(queues: string[]): Promise<void> {
    await this.consumerChannelPool.usingChannel(async channel => {
      await Promise.all(_.map(queues, async (queue: string) => {
        await channel.assertQueue(queue, { durable: false, expires: RPC_QUEUE_EXPIRES_MS });
      }));
    });
  }

  private async assertExchanges(rpcEntities: RpcEntities): Promise<void> {
    await this.consumerChannelPool.usingChannel(async channel => {
      await Promise.all(_.map(rpcEntities, async ({ type, handler, rpcOptions }, rpcName: string) => {
        await channel.assertExchange(rpcName, 'direct', { autoDelete: true, durable: false });
      }));
    });
  }

  private async bindQueuesToExchanges(queues: string[], rpcEntities: RpcEntities): Promise<void> {
    const bindInfos = _.flatten(_.map(_.keys(this.rpcEntities), rpcName => {
      return _.map(queues, queue => ({ queue, rpcName, routingKey: _.last(queue.split('.')) } ));
    }));
    await this.consumerChannelPool.usingChannel(async channel => {
      await Promise.all(_.map(bindInfos, async ({queue, rpcName, routingKey}) => {
        await channel.bindQueue(queue, rpcName, routingKey!);
      }));
    });
  }

  private async startConsumingQueues(queues: string[]): Promise<void> {
    await this.consumerChannelPool.usingChannel(async channel => {
      await Bluebird.each(queues, async queue => {
        const consumerInfo = await this.startConsumingQueue(queue);
        this.requestConsumerInfo.push(consumerInfo);
      });
    });
  }

  private async startConsumingQueue(queue: string): Promise<IConsumerInfo> {
    return this._consume(queue, async (msg: Message) => {
      const rpcName = msg.fields.exchange;
      if (!this.rpcEntities[rpcName]) {
        logger.warning('no such RPC found', rpcName);
        return;
      }
      const { type, handler, rpcOptions } = this.rpcEntities[rpcName];
      const { replyTo, headers, correlationId } = msg.properties;
      if (!replyTo) throw ISLAND.FATAL.F0026_MISSING_REPLYTO_IN_RPC;

      const tattoo = headers && headers.tattoo;
      const extra = headers && headers.extra || {};

      return this.enterCLS(tattoo, rpcName, extra, async () => {
        const options = { correlationId, headers };
        const parsed = JSON.parse(msg.content.toString('utf8'), RpcResponse.reviver);
        const requestId: string = collector.collectRequestAndReceivedTime(type, rpcName, { msg });
        try {
          this.increaseRequest(rpcName, 1);
          await Bluebird.resolve()
            .then(()  => sanitizeAndValidate(parsed, rpcOptions))
            .tap (req => logger.debug(`Got ${rpcName} with ${JSON.stringify(req)}`))
            .then(req => this.dohook('pre', type, req))
            .then(req => handler(req))
            .then(res => this.dohook('post', type, res))
            .then(res => sanitizeAndValidateResult(res, rpcOptions))
            .then(res => this.reply(replyTo, res, options))
            .tap (() => collector.collectExecutedCountAndExecutedTime(type, rpcName, { requestId }))
            .tap (res => logger.debug(`responses ${JSON.stringify(res)} ${type}, ${rpcName}`))
            .timeout(RPC_EXEC_TIMEOUT_MS);
        } catch (err) {
          await Bluebird.resolve(err)
            .then(err => this.earlyThrowWith503(rpcName, err, msg))
            .then(err => this.dohook('pre-error', type, err))
            .then(err => this.attachExtraError(err, rpcName, parsed))
            .then(err => this.reply(replyTo, err, options))
            .then(err => this.dohook('post-error', type, err))
            .tap (() => collector.collectExecutedCountAndExecutedTime(type, rpcName, { requestId, err }))
            .tap (err => this.logRpcError(err));
          throw err;
        } finally {
          this.increaseRequest(rpcName, -1);
          if (this.purging && this.onGoingRequest.count < 1) {
            this.purging();
          }
        }
      });
    });
  }

}
