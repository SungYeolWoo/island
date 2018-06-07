import * as amqp from 'amqplib';
import { CalculatedData, StatusExporter } from 'island-status-exporter';
import * as _ from 'lodash';
import * as uuid from 'uuid';

import { Environments } from '../utils/environments';
import { logger } from '../utils/logger';

export const STATUS_EXPORT: boolean = Environments.isStatusExport();
export const STATUS_EXPORT_TIME_MS: number = Environments.ISLAND_STATUS_EXPORT_TIME_MS; // 10 * 1000
const STATUS_FILE_NAME: string = Environments.getStatusFileName()!;
const STATUS_EXPORT_TYPE: string = Environments.getStatusExportType();
const HOST_NAME: string = Environments.getHostName()!;
const SERVICE_NAME: string = Environments.getServiceName()!;

const CIRCUIT_BREAK_TIME_MS: number = Environments.ISLAND_CIRCUIT_BREAK_TIME_MS;
const MIN_REQUEST_THRESHOLD: number = Environments.ISLAND_CIRCUIT_BREAK_REQUEST_THRESHOLD;
const CIRCUIT_BREAK_THRESHOLD: number = Environments.ISLAND_CIRCUIT_BREAK_FAILRATE_THRESHOLD;

const processUptime: Date = new Date();
// const SAVE_FILE_NAME: string = '';

if (STATUS_EXPORT)
  StatusExporter.initialize({
    name: STATUS_FILE_NAME,
    hostname: HOST_NAME,
    servicename: SERVICE_NAME
  });

export interface Message {
  content: Buffer;
  properties: amqp.Options.Publish;
}

interface RequestStatistics {
  requestCount: number;
  executedCount: number;
  totalReceivedTime: number;
  totalExecutionTime: number;
  totalErrorTime: number;
  lastErrorCounts: { reqCount: number, errCount: number }[];
}

export interface CollectOptions {
  requestId?: string;
  msg?: Message;
  shard?: number;
  err?: any;
  ignoreTimestamp?: boolean;
}

class RequestStatisticsHelper {
  public static create(): RequestStatistics {
    return {
      requestCount: 0,
      executedCount: 0,
      totalReceivedTime: 0,
      totalExecutionTime: 0,
      totalErrorTime: 0,
      lastErrorCounts: new Array(Math.max(1, Math.ceil(CIRCUIT_BREAK_TIME_MS / STATUS_EXPORT_TIME_MS)))
    } as RequestStatistics;
  }

  public static clearAndShift(stat: RequestStatistics) {
    stat.lastErrorCounts.shift();
    stat.lastErrorCounts.push({
      reqCount: stat.requestCount,
      errCount: stat.requestCount - stat.executedCount
    });
    stat.requestCount = 0;
    stat.executedCount = 0;
    stat.totalReceivedTime = 0;
    stat.totalExecutionTime = 0;
    stat.totalErrorTime = 0;
  }

  public static needCircuitBreak(stat: RequestStatistics): boolean {
    let reqCount = 0;
    let errCount = 0;
    _.forEach(stat.lastErrorCounts, v => {
      if (!v) return;
      reqCount += v.reqCount;
      errCount += v.errCount;
    });

    if (reqCount < MIN_REQUEST_THRESHOLD) return false;

    const failedRate = errCount / reqCount;
    return failedRate >= CIRCUIT_BREAK_THRESHOLD;
  }
}

function setDecimalPoint(int: number): number {
  return Number(int.toFixed(2));
}

export type ColllectedStatusExporter = (collected: CalculatedData) => Promise<any>;

export class StatusCollector {
  private collectedData: { [type: string]: RequestStatistics } = {};
  private onGoingMap: Map<string, any> = new Map();
  private startedAt: number = +new Date();
  private exporters: {[key: string]: ColllectedStatusExporter} = {
    FILE: o => StatusExporter.saveStatusJsonFile(o)
  };

  public async saveStatus() {
    const calculated: CalculatedData = this.calculateMeasurementsByType();
    this.clearAndShiftData();
    const exporter = this.exporters[STATUS_EXPORT_TYPE];
    if (!exporter) return;
    return exporter(calculated);
  }

  public async registerExporter(type: string, exporter: ColllectedStatusExporter) {
    this.exporters[type] = exporter;
  }

  // Note:
  // island.js 통해 받지 않는 요청('gateway의 restify', 'push의 socket') 또는 보낸 곳에서 시간값을 주지 않은 요청의 경우는 time 필드가 없다.
  public collectRequestAndReceivedTime(type: string, name: string, options?: CollectOptions): string {
    const requestId = options && options.requestId ? options.requestId : uuid.v1();
    const req = { type, name, reqTime: +new Date(), recvTime: 0 };

    if (options && !options.ignoreTimestamp
        && options.msg && options.msg.properties && options.msg.properties.timestamp) {
      const elapsedFromPublished = req.reqTime - options.msg.properties.timestamp;

      if (elapsedFromPublished > 1000) {
        logger.warning('SLOW recv', name, elapsedFromPublished, options.shard);
      }

      req.recvTime = req.reqTime - options.msg.properties.timestamp;
    }

    this.onGoingMap.set(requestId, req);
    return requestId;
  }

  public collectExecutedCountAndExecutedTime(type: string, name: string, options: CollectOptions) {
    if (!options.requestId) {
      const stat: RequestStatistics = this.getStat(type, name);
      ++stat.requestCount;
      if (!options.err) ++stat.executedCount;
      return;
    }

    const reqCache = this.onGoingMap.get(options.requestId);
    if (!reqCache) return;
    this.onGoingMap.delete(options.requestId);

    const stat: RequestStatistics = this.getStat(type, name);
    ++stat.requestCount;
    if (!options.err) ++stat.executedCount;

    const resTime = +new Date();
    const reqTime = reqCache.reqTime || resTime;
    if (reqCache.recvTime) {
      stat.totalReceivedTime += reqCache.recvTime;
    }
    if (options.err) {
      stat.totalErrorTime += resTime - reqTime;
      if (RequestStatisticsHelper.needCircuitBreak(stat)) {
        logger.warning(`Too Many Failure on ${type} with fail-rate ${MIN_REQUEST_THRESHOLD}`);
      }
    } else {
      stat.totalExecutionTime += resTime - reqTime;
    }
  }

  public calculateMeasurementsByType(): CalculatedData {
    const measuringTime = +new Date() - this.startedAt;
    const cd = _.clone(this.collectedData);

    const result: CalculatedData = { processUptime, measurements: [] };
    const parsedData = {};

    _.forEach(cd, (stat: RequestStatistics, type: string) => {
      parsedData[type] = parsedData[type] || {
        type,
        requestPerSeconds: 0,
        executedPerSeconds: 0,
        avgReceiveMessageTimeByMQ: 0,
        avgExecutionTime: 0
      };
      parsedData[type].requestPerSeconds += stat.requestCount;
      parsedData[type].executedPerSeconds += stat.executedCount;
      parsedData[type].avgReceiveMessageTimeByMQ += stat.totalReceivedTime;
      parsedData[type].avgExecutionTime += stat.totalExecutionTime;
    });

    result.measurements = [];

    _.forEach(parsedData, (stat: any) => {
      stat.avgReceiveMessageTimeByMQ = setDecimalPoint(stat.avgReceiveMessageTimeByMQ / stat.requestPerSeconds);
      stat.avgExecutionTime = setDecimalPoint(stat.avgExecutionTime / stat.executedPerSeconds);
      stat.requestPerSeconds = setDecimalPoint(stat.requestPerSeconds * 1000 / measuringTime);
      stat.executedPerSeconds = setDecimalPoint(stat.executedPerSeconds * 1000 / measuringTime);

      result.measurements = result.measurements || [];
      result.measurements.push(stat);
    });

    return result;
  }

  public async sigInfo(type: string) {
    logger.info(`${type} Service onGoingRequestCount : ${this.getOnGoingRequestCount(type)}`);
    _.forEach(this.collectedData, (v: RequestStatistics, k: string) => {
      if (!k.startsWith(type)) return;
      logger.info(`${type} Service ${k} : ${v}`);
    });
  }

  public getOnGoingRequestCount(type?: string): number {
    if (!type) return this.onGoingMap.size;
    let onGoingRequestCount = 0;
    this.onGoingMap.forEach((value: any) => {
      if (value.type && value.type.startsWith(type)) {
        onGoingRequestCount += 1;
      }
    });
    return onGoingRequestCount;
  }

  public hasOngoingRequests(type?: string): boolean {
    return this.getOnGoingRequestCount(type) > 0;
  }

  public needCircuitBreak(type: string, name: string): boolean {
    const stat = this.getStat(type, name);
    return RequestStatisticsHelper.needCircuitBreak(stat);
  }

  private getStat(type: string,  name: string): RequestStatistics {
    const typeName = [type, name].join('@');
    this.collectedData[typeName] = this.collectedData[typeName] || RequestStatisticsHelper.create();
    return this.collectedData[typeName];
  }

  private clearAndShiftData() {
    _.forEach(this.collectedData, (stat: RequestStatistics) => {
      RequestStatisticsHelper.clearAndShift(stat);
    });
    this.startedAt = +new Date();
  }
}

export const collector = new StatusCollector();
