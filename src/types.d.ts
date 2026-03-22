declare module 'sql.js' {
  type SqlValue = string | number | null | Uint8Array;
  type SqlParams = SqlValue[];
  type SqlObject = Record<string, SqlValue | undefined>;
  interface SqlJsInitConfig {
    locateFile?: (file: string) => string;
  }

  interface Database {
    run(sql: string, params?: SqlParams): void;
    prepare(sql: string): Statement;
    export(): Uint8Array;
    close(): void;
  }

  interface Statement {
    bind(params?: SqlParams): void;
    step(): boolean;
    getAsObject(): SqlObject;
    free(): void;
  }

  interface SqlJsStatic {
    Database: new (data?: ArrayLike<number>) => Database;
  }

  export default function initSqlJs(config?: SqlJsInitConfig): Promise<SqlJsStatic>;
  export type { Database, Statement, SqlJsStatic };
}
