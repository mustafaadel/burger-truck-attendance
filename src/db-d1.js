// Cloudflare D1 adapter: same interface as db-node.js.
export function d1Db(d1) {
  const st = (sql, p) => d1.prepare(sql).bind(...p);
  return {
    all: async (sql, ...p) => (await st(sql, p).all()).results,
    get: async (sql, ...p) => st(sql, p).first(),
    run: async (sql, ...p) => {
      const r = await st(sql, p).run();
      return { changes: r.meta.changes, lastId: r.meta.last_row_id };
    },
    batch: async (stmts) => { await d1.batch(stmts.map(([sql, p]) => st(sql, p))); }, // atomic in D1
  };
}
