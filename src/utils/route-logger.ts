import * as cls from 'continuation-local-storage';
import { Environments } from '../utils/environments';
import { logger } from '../utils/logger';

const USE_TRACE_HEADER_LOG = Environments.isUsingTraceHeaderLog();

export type RouteType = 'req' | 'res';
export type RouteProtocol = 'EVENT' | 'RPC';

export interface RouteLog {
  sender: string;
  recevier?: string;
  type: RouteType;
  protocol: RouteProtocol;
  correlationId: string;
  node: string;
  context: string;
}

export interface RouteLogParams {
  clsNameSpace: string;
  type: RouteType;
  protocol: RouteProtocol;
  correlationId: string;
  context?: string;
}

export class RouteLogger {
  static bind(clsNameSpace, callback): () => any {
    return cls.getNamespace(clsNameSpace).bind(callback);
  }

  static saveLogs(routeLogParams: RouteLogParams[]): void {
    for (var params of routeLogParams) {
      RouteLogger.saveLog(params);
    }
  }

  static saveLog(routeLogParams: RouteLogParams): void {
    const {clsNameSpace,  type, protocol, correlationId, context } = routeLogParams;
    if (!USE_TRACE_HEADER_LOG) return;

    RouteLogger.bind(clsNameSpace, () => {
      const ns = cls.getNamespace(clsNameSpace);

      let routeLogs = ns.get('routeLogs') || [];
      routeLogs.push({
        node: Environments.getHostName(),
        context: context,
        sender: Environments.getServiceName(),
        type,
        protocol,
        correlationId
      });

      ns.set('routeLogs', routeLogs);
    })();
  }

  static getLogs(clsNameSpace): RouteLog[] {
    if (!USE_TRACE_HEADER_LOG) return [];

    return RouteLogger.bind(clsNameSpace, () => {
      const ns = cls.getNamespace(clsNameSpace);
      return ns.get('routeLogs') || [];
    })();
  }

  static replaceLogs(clsNameSpace, routeLog: RouteLog[]): void {
    if (!USE_TRACE_HEADER_LOG) return;

    RouteLogger.bind(clsNameSpace, () => {
      const ns = cls.getNamespace(clsNameSpace);
      ns.set('routeLogs', routeLog);
    })();
  }

  static print(clsNameSpace: string): void {
    if (!USE_TRACE_HEADER_LOG) return;

    RouteLogger.bind(clsNameSpace, () => {
      const ns = cls.getNamespace(clsNameSpace);
      logger.debug(`TraceHeaderLog:\n${JSON.stringify(ns.get('routeLogs'), null, 2)}`);
    })();
  }
}

