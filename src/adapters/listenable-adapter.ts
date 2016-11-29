import * as Bluebird from 'bluebird';
import AbstractAdapter, { IAbstractAdapter } from './abstract-adapter';
import AbstractController from '../controllers/abstract-controller';
import { FatalError, ISLAND } from '../utils/error';
/**
 * IListenableAdapter
 * @interface
 */
export interface IListenableAdapter extends IAbstractAdapter {
  // HACK: 모든 abstract adapter의 initialize가 호출 된 다음에 호출된다
  postInitialize(): any | Promise<any>;
  listen(): any | Promise<any>;
}

/**
 * Abstract adapter class for back-end service.
 * @abstract
 * @class
 * @extends AbstractAdapter
 * @implements IListenableAdapter
 */
export default class ListenableAdapter<T, U> extends AbstractAdapter<T, U> implements IListenableAdapter {
  private _controllersClasses: typeof AbstractController[] = [];
  private _controllers: AbstractController<T>[] = [];

  /**
   * @param {AbstractController} Class
   */
  public registerController(Class: typeof AbstractController) {
    this._controllersClasses.push(Class);
  }

  /**
   * @returns {Promise<void>}
   * @final
   */
  public postInitialize(): Promise<any> {
    return Promise.all(this._controllersClasses.map(ControllerClass => {
      const c = new ControllerClass(this._adaptee);
      this._controllers.push(c);
      return Bluebird.try(() => c.initialize()).then(() => c.onInitialized());
    }));
  }

  /**
   * @abstract
   * @returns {Promise<void>}
   */
  public listen(): any | Promise<any> {
    throw new FatalError(ISLAND.FATAL.F0004_NOT_IMPLEMENTED_ERROR, 'Not implemented error');
  }

  public async destroy(): Promise<any> {
    await Promise.all(this._controllers.map(c => Bluebird.try(() => c.destroy())));
    await Promise.all(this._controllers.map(c => Bluebird.try(() => c.onDestroy())));
    
    this._controllersClasses = [];
    this._controllers = [];
  }
}
