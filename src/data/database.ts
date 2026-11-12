import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';

/** Scalar values a fixed query may bind. Never SQL fragments. */
export type SqlParam = string | number | null;
export type SqlRow = Record<string, unknown>;

/**
 * The only database surface the rest of the service sees: run a fixed, parameterized SELECT or call an
 * allowlisted stored procedure. Kept narrow so tests can substitute a fake and no caller can issue DDL/DML.
 */
export interface QueryExecutor {
  select(sql: string, params: readonly SqlParam[]): Promise<SqlRow[]>;
  /** Call an allowlisted procedure; returns its first result set. */
  callProcedure(procedureName: string, params: readonly SqlParam[]): Promise<SqlRow[]>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export class QueryTimeoutError extends Error {
  override readonly name = 'QueryTimeoutError';
  readonly code = 'QUERY_TIMEOUT';
}

const IDENTIFIER = /^[A-Za-z0-9_]{1,64}$/;
const CLIENT_TIMEOUT_CODE = 'PROTOCOL_SEQUENCE_TIMEOUT';

/**
 * Aurora MySQL-backed executor (MySQL 8.0-compatible, Aurora MySQL v3).
 *
 * Defence in depth on top of the least-privilege DB user:
 * - every pooled session is `READ ONLY`, so even a stored procedure that tries to write is refused by the server;
 * - `MAX_EXECUTION_TIME` bounds top-level SELECTs server-side;
 * - every statement also has a client timeout which, when hit, runs `KILL QUERY` on the server thread
 *   (MAX_EXECUTION_TIME does not apply to statements inside stored procedures) and discards the connection;
 * - multi-statements are disabled and values are always bound through server-side prepared statements.
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
      // verifyIdentity: also check the certificate hostname (mysql2 skips it for IP hosts, e.g. an SSH tunnel on 127.0.0.1).
      ssl: config.sslDisabled ? undefined : { ca: config.sslCa, rejectUnauthorized: true, verifyIdentity: true },
    });

    // A connection runs its commands in order, so these apply before any query on that session.
    this.pool.pool.on('connection', (connection) => {
      connection.query('SET SESSION TRANSACTION READ ONLY');
      connection.query('SET SESSION MAX_EXECUTION_TIME = ?', [config.statementTimeoutMs]);
    });
  }

  async select(sql: string, params: readonly SqlParam[]): Promise<SqlRow[]> {
    return this.run(sql, params, (result) => result as RowDataPacket[]);
  }

  async callProcedure(procedureName: string, params: readonly SqlParam[]): Promise<SqlRow[]> {
    if (!IDENTIFIER.test(procedureName)) throw new RangeError('Invalid procedure name');
    const placeholders = params.map(() => '?').join(', ');
    // CALL returns [resultSet1, ..., ResultSetHeader]; tools read only the first result set.
    return this.run(`CALL \`${procedureName}\`(${placeholders})`, params, (result) => {
      const first = Array.isArray(result) ? result[0] : undefined;
      return Array.isArray(first) ? (first as SqlRow[]) : [];
    });
  }

  async ping(): Promise<void> {
    await this.select('SELECT 1', []);
  }

  async close(): Promise<void> {
    await this.pool.end();
    this.logger.info('db.pool_closed');
  }

  private async run(sql: string, params: readonly SqlParam[], extract: (result: unknown) => SqlRow[]): Promise<SqlRow[]> {
    const connection = await this.pool.getConnection();
    let reusable = true;
    try {
      const [result] = await connection.execute({ sql, timeout: this.config.statementTimeoutMs }, [...params]);
      return extract(result);
    } catch (error) {
      if (isClientTimeout(error)) {
        reusable = false;
        await this.killServerQuery(connection.threadId);
        throw new QueryTimeoutError('Statement exceeded the configured time limit', { cause: error });
      }
      throw error;
    } finally {
      if (reusable) connection.release();
      else connection.destroy();
    }
  }

  /** Stop the statement server-side. A user may always kill queries on its own threads. */
  private async killServerQuery(threadId: number): Promise<void> {
    try {
      await this.pool.query('KILL QUERY ?', [threadId]);
      this.logger.warn('db.query_killed', { threadId });
    } catch (error) {
      this.logger.error('db.kill_failed', { threadId, errorName: error instanceof Error ? error.name : 'unknown' });
    }
  }
}

function isClientTimeout(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === CLIENT_TIMEOUT_CODE;
}
