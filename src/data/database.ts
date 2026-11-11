import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';

/** Scalar values a fixed query may bind. Never SQL fragments. */
export type SqlParam = string | number;
export type SqlRow = Record<string, unknown>;

/**
 * The only database surface the rest of the service sees: run a fixed, parameterized SELECT.
 * Kept narrow so tests can substitute an in-memory fake and so no caller can issue DDL/DML helpers.
 */
export interface QueryExecutor {
  select(sql: string, params: readonly SqlParam[]): Promise<SqlRow[]>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

/**
 * MySQL-backed executor (provisional engine per plan §11; confirm before production).
 *
 * Defence in depth on top of the least-privilege DB principal:
 * - every pooled session is set `READ ONLY` with a server-side statement time limit;
 * - multi-statements are disabled;
 * - each query also carries a client-side timeout;
 * - statements are server-side prepared (`execute`), so values are never spliced into SQL.
 */
export class MySqlQueryExecutor implements QueryExecutor {
  private readonly pool: Pool;

  constructor(
    private readonly config: AppConfig['database'],
    private readonly logger: Logger,
  ) {
    this.pool = mysql.createPool({
      host: config.host,
      port: config.port,
      database: config.name,
      user: config.user,
      password: config.password,
      connectionLimit: config.connectionLimit,
      queueLimit: config.connectionLimit * 2,
      connectTimeout: config.statementTimeoutMs,
      multipleStatements: false,
      dateStrings: true,
      decimalNumbers: true,
      supportBigNumbers: true,
      ssl: config.sslDisabled ? undefined : { ca: config.sslCa, rejectUnauthorized: true },
    });

    // MySQL processes a connection's commands in order, so these run before any query on that session.
    // NOTE: MAX_EXECUTION_TIME is MySQL-specific; MariaDB uses `max_statement_time` (seconds).
    this.pool.pool.on('connection', (connection) => {
      connection.query('SET SESSION TRANSACTION READ ONLY');
      connection.query('SET SESSION MAX_EXECUTION_TIME = ?', [config.statementTimeoutMs]);
    });
  }

  async select(sql: string, params: readonly SqlParam[]): Promise<SqlRow[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>({ sql, timeout: this.config.statementTimeoutMs }, [...params]);
    return rows;
  }

  async ping(): Promise<void> {
    await this.pool.query({ sql: 'SELECT 1', timeout: this.config.statementTimeoutMs });
  }

  async close(): Promise<void> {
    await this.pool.end();
    this.logger.info('db.pool_closed');
  }
}
