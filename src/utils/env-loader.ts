import 'reflect-metadata';

import * as _ from 'lodash';
import * as inspector from 'schema-inspector';

export class SchemaStorage {
  private _schemaMetadata: any[] = [];

  get schemaMetadata(): any[] {
    return this._schemaMetadata;
  }

  public addSchemaMetadata(targetConstructor: Function, metadata: any) {
    const { type, propertyName, opts } = metadata;
    let targetMetadata = this.getSchemasForObject(targetConstructor);
    if (targetMetadata) {
      targetMetadata.schema.properties[propertyName] = opts;
      targetMetadata.schema.properties[propertyName].type = type;
    } else {
      targetMetadata = {
        key: targetConstructor,
        schema: {
          type: 'object',
          properties: {}
        }
      };
      targetMetadata.schema.properties[propertyName] = opts;
      targetMetadata.schema.properties[propertyName].type = type;
      this._schemaMetadata.push(targetMetadata);
    }
  }

  public getSchemasForObject(targetConstructor: Function): any {
    return this.schemaMetadata.find(metadata => {
      if (metadata.key === targetConstructor)
        return true;
      if (metadata.key instanceof Function &&
        !(targetConstructor.prototype instanceof (metadata.key as Function)))
           return false;

      return true;
    });
  }
}

const defaultSchemaStorage = new SchemaStorage();

function makeDecorator(optionalSchema?: any) {
  return (object: Object, propertyName: string) => {
    const metadata = Reflect.getMetadata('design:type', object, propertyName);
    // console.log(`${propertyName} props: ${Object.getOwnPropertyNames(metadata)}`);

    let type = '';
    switch (metadata.name) {
      case 'String':
      case 'Number':
      case 'Boolean':
      type = metadata.name.toLowerCase();
      break;
    }

    defaultSchemaStorage.addSchemaMetadata(object.constructor, {
      type,
      propertyName,
      opts: optionalSchema || {}
    });
  };
}

function isInvalidEnvValue(value) {
  if (value === undefined) return true;
  if (typeof value === 'number' && isNaN(value)) return true;
  return false;
}

function loadValueFromEnv(schema: any, object: any, itemKey: string): void {
  let defaultValue: any = undefined;

  const keys = (schema.legacyKeys && schema.legacyKeys.length) ? [itemKey].concat(schema.legacyKeys) : [itemKey];

  _.some(keys, envKey => {
    const envVar = process.env[envKey];
    if (envVar === undefined || envVar === '') {
      return false;
    }

    switch (schema.type) {
      case 'boolean':
        {
          const lowerCase = envVar.toLowerCase();
          switch (lowerCase) {
            // for support tencent-island.(legacy codes)
            case '1':
            case 'true':
              defaultValue = true;
              break;
            case '0':
            case 'false':
              defaultValue = false;
              break;
          }
        }
        break;
      case 'number':
      case 'float':
        defaultValue = parseFloat(envVar);
        break;
      case 'int':
      case 'integer':
        defaultValue = parseInt(envVar, 10);
        break;
      case 'string':
      default:
        defaultValue = envVar;
        break;
    }
    return true;
  });

  if (isInvalidEnvValue(defaultValue)) {
    defaultValue = object[itemKey];
  }

  if (isInvalidEnvValue(defaultValue) && schema.optional === false) {
    throw new Error(`Environment "${itemKey}": not optional and has no data`);
  }
  object[itemKey] = defaultValue;
}

function loadAndSanitize(object: any): void {
  const metadata = defaultSchemaStorage.getSchemasForObject(object.constructor);
  _.forEach(metadata.schema.properties, (schema, key) => {
    if (typeof schema.optional !== 'boolean') {
      schema.optional = schema.required === false;
    }

    loadValueFromEnv(schema, object, key);
  });

  inspector.sanitize(metadata.schema, object);
  const result = inspector.validate(metadata.schema, object);
  const errors = _.filter(result.error || [], v => v.reason !== 'type' && v.property !== '@');
  if (errors.length) {
    throw new Error(JSON.stringify(errors));
  }
}

// Do not execute before sanitize
function setReadonly(object: any): void {
  const metadata = defaultSchemaStorage.getSchemasForObject(object.constructor);
  _.forEach(metadata.schema.properties, (schema, key) => {
    if (!schema.writable) {
      Object.defineProperty(object, key, {
        writable: false
      });
    }
  });
}

/**
 * environment decorator - 3 custom options & schema-inspector options
 * required: boolean - default true, also supports optional.
 * legacyKeys: array of string - find process.env[some of legacyKeys] when process.env[key] is undefined
 *
 * only supports 1 depth object.
 */
// TODO : support TypeScript 2.7 definite property assignment assertion - reflection didn't support yet
export function env(optionalSchema?: any) {
  return makeDecorator(optionalSchema);
}

export function LoadEnv(object: any): void {
  loadAndSanitize(object);
  return;
}

export function SetReadonly(object: any): void {
  setReadonly(object);
  return;
}
