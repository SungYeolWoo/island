// tslint:disable-next-line
require('source-map-support').install();
// Don't change the order;
export { Loggers, cls } from 'island-loggers';

export import mongoose = require('mongoose');
mongoose.Promise = Promise as any;

import Islet from './islet';
export { Islet };

// adapters
export { default as AbstractAdapter, IAbstractAdapter } from './adapters/abstract-adapter';
export { default as ListenableAdapter } from './adapters/listenable-adapter';

// adapters/impl
export { default as MessageBrokerAdapter } from './adapters/impl/message-broker-adapter';
export { default as MongooseAdapter, MongooseAdapterOptions } from './adapters/impl/mongoose-adapter';
export { default as PushAdapter, PushAdapterOptions } from './adapters/impl/push-adapter';
export { default as RedisConnectionAdapter, RedisAdapterOptions } from './adapters/impl/redis-connection-adapter';
export { default as RestifyAdapter, RestifyAdapterOptions } from './adapters/impl/restify-adapter';
export { default as RPCAdapter, RPCAdapterOptions } from './adapters/impl/rpc-adapter';
export { default as SocketIOAdapter, SocketIOAdapterOptions } from './adapters/impl/socketio-adapter';
export { default as RabbitMqAdapter, RabbitMqAdapterOptions } from './adapters/impl/rabbitmq-adapter';
export { AmqpChannelPoolAdapter } from './adapters/impl/amqp-channel-pool-adapter';
export { EventAdapter, EventAdapterOptions } from './adapters/impl/event-adapter';

// controllers
export { default as AbstractController } from './controllers/abstract-controller';
export {
  validate,
  sanitize,
  admin,
  extra,
  auth,
  devonly,
  mangle,
  nosession,
  ensure,
  EnsureOptions,
  EndpointOptions,
  EndpointSchemaOptions,
  endpoint,
  endpointController,
  quota,
  groupServiceQuota,
  groupQuota,
  sessionGroup
} from './controllers/endpoint-decorator';
export {
  rpc,
  rpcController
} from './controllers/rpc-decorator';
export {
  Response,
  middleware
} from './controllers/middleware-decorator';
export { eventController, subscribeEvent, subscribePattern } from './controllers/event-decorator';

// models
/**
 * @deprecated
 */
export { default as ModelFactory } from './models/model-factory';

// services
export { default as MessageBrokerService } from './services/message-broker-service';
export { default as PushService, BroadcastTarget, BroadcastTargets } from './services/push-service';
export { default as RPCService, RpcHook, RpcHookType } from './services/rpc-service';

export {
  default as AbstractBrokerService,
  IConsumerInfo
} from './services/abstract-broker-service';
export { AmqpChannelPoolService, AmqpOptions } from './services/amqp-channel-pool-service';
export { EventService } from './services/event-service';
export { Event, BaseEvent } from './services/event-subscriber';

// utils
export { Environments } from './utils/environments';
export { TraceLog } from './utils/tracelog';
export { ScopeExit } from './utils/scope-exit';
export { ResourcePush } from './utils/resource-push';
export { default as MessagePack } from './utils/msgpack';
export { default as StaticDataLoader } from './utils/staticdata-loader';
export { default as StaticDataFactory } from './utils/staticdata-factory';
export {
  jasmineAsyncAdapter as spec,
  createSpyObjWithAllMethods as spyAll,
  resetSpyObjWithCallsCount as resetCallsCount
} from './utils/jasmine-async-support';
export {
  AbstractError,
  AbstractExpectedError,
  AbstractFatalError,
  AbstractLogicError,
  ErrorLevel,
  IslandLevel,
  toCode,
  setIslandCode
} from './utils/error';
export { Events } from './utils/event';
export { IntervalHelper } from './utils/interval-helper';
export { collector } from './utils/status-collector';
export { env, LoadEnv } from './utils/env-loader';

export { Di, ObjectWrapper, ObjectFactory } from 'island-di';
export { RouteLogger } from './utils/route-logger';
