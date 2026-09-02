import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_VERSION = '2';

function nowIso() {
  return new Date().toISOString();
}

export class Database {
  constructor(path = 'data/bot.db') {
    mkdirSync(dirname(path), { recursive: true });
    this.connection = new DatabaseSync(path);
    this.connection.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    this.createSchema();
  }

  tableExists(name) {
    return this.connection.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(name) !== undefined;
  }

  createSchema() {
    const currentVersion = this.tableExists('settings')
      ? this.connection.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get()?.value
      : null;
    if (this.tableExists('parents') && currentVersion !== SCHEMA_VERSION) {
      this.connection.exec(`
        DROP TABLE IF EXISTS deliveries;
        DROP TABLE IF EXISTS orders;
        DROP TABLE IF EXISTS children;
        DROP TABLE IF EXISTS parents;
        DROP TABLE IF EXISTS settings;
      `);
    }

    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS parents (
        user_id INTEGER PRIMARY KEY,
        chat_id INTEGER NOT NULL,
        display_name TEXT NOT NULL,
        state TEXT,
        view_mode TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS children (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        parent_user_id INTEGER NOT NULL REFERENCES parents(user_id) ON DELETE CASCADE,
        child_name TEXT NOT NULL,
        class_name TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        child_id INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
        target_date TEXT NOT NULL,
        breakfast INTEGER NOT NULL DEFAULT 0,
        lunch INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        UNIQUE(child_id, target_date)
      );

      CREATE INDEX IF NOT EXISTS ix_children_parent ON children(parent_user_id, active);
      CREATE INDEX IF NOT EXISTS ix_children_class ON children(class_name, active);
      CREATE INDEX IF NOT EXISTS ix_orders_target_date ON orders(target_date);

      CREATE TABLE IF NOT EXISTS deliveries (
        key TEXT PRIMARY KEY,
        delivered_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.setSetting('schema_version', SCHEMA_VERSION);
  }

  upsertParent(user, chatId) {
    const userId = Number(user.user_id);
    const displayName =
      user.name?.trim() ||
      [user.first_name, user.last_name].filter(Boolean).join(' ').trim() ||
      `Пользователь ${userId}`;
    const timestamp = nowIso();
    this.connection.prepare(`
      INSERT INTO parents (user_id, chat_id, display_name, active, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        chat_id = excluded.chat_id,
        display_name = excluded.display_name,
        active = 1,
        updated_at = excluded.updated_at
    `).run(userId, Number(chatId ?? userId), displayName, timestamp, timestamp);
    return this.getParent(userId);
  }

  getParent(userId) {
    return this.connection.prepare('SELECT * FROM parents WHERE user_id = ?').get(userId) ?? null;
  }

  markParentInactive(userId) {
    this.connection.prepare('UPDATE parents SET active = 0, updated_at = ? WHERE user_id = ?')
      .run(nowIso(), userId);
  }

  setParentState(userId, state) {
    this.connection.prepare('UPDATE parents SET state = ?, updated_at = ? WHERE user_id = ?')
      .run(state, nowIso(), userId);
  }

  setViewMode(userId, mode) {
    this.connection.prepare(
      'UPDATE parents SET view_mode = ?, state = NULL, updated_at = ? WHERE user_id = ?',
    ).run(mode, nowIso(), userId);
  }

  addChild(userId, childName, className) {
    const timestamp = nowIso();
    const result = this.connection.prepare(`
      INSERT INTO children (parent_user_id, child_name, class_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(userId, childName, className, timestamp, timestamp);
    return this.getChild(Number(result.lastInsertRowid));
  }

  childrenForParent(userId) {
    return this.connection.prepare(`
      SELECT * FROM children
      WHERE parent_user_id = ? AND active = 1
      ORDER BY class_name, child_name COLLATE NOCASE, id
    `).all(userId);
  }

  childrenForClass(className) {
    return this.connection.prepare(`
      SELECT c.*, p.display_name AS parent_name, p.user_id AS owner_id
      FROM children c
      JOIN parents p ON p.user_id = c.parent_user_id
      WHERE c.class_name = ? AND c.active = 1
      ORDER BY c.child_name COLLATE NOCASE, c.id
    `).all(className);
  }

  allChildren() {
    return this.connection.prepare(`
      SELECT c.*, p.display_name AS parent_name, p.user_id AS owner_id
      FROM children c
      JOIN parents p ON p.user_id = c.parent_user_id
      WHERE c.active = 1
      ORDER BY c.class_name, c.child_name COLLATE NOCASE, c.id
    `).all();
  }

  getChild(childId, ownerId = null) {
    const sql = ownerId === null
      ? 'SELECT * FROM children WHERE id = ? AND active = 1'
      : 'SELECT * FROM children WHERE id = ? AND parent_user_id = ? AND active = 1';
    return (ownerId === null
      ? this.connection.prepare(sql).get(childId)
      : this.connection.prepare(sql).get(childId, ownerId)) ?? null;
  }

  updateChildName(childId, childName) {
    return this.connection.prepare(`
      UPDATE children SET child_name = ?, updated_at = ? WHERE id = ? AND active = 1
    `).run(childName, nowIso(), childId).changes > 0;
  }

  updateChildClass(childId, className) {
    return this.connection.prepare(`
      UPDATE children SET class_name = ?, updated_at = ? WHERE id = ? AND active = 1
    `).run(className, nowIso(), childId).changes > 0;
  }

  deleteChild(childId) {
    return this.connection.prepare('DELETE FROM children WHERE id = ? AND active = 1')
      .run(childId).changes > 0;
  }

  getOrder(childId, targetDate) {
    return this.connection.prepare('SELECT * FROM orders WHERE child_id = ? AND target_date = ?')
      .get(childId, targetDate) ?? null;
  }

  saveOrder(childId, targetDate, breakfast, lunch) {
    this.connection.prepare(`
      INSERT INTO orders (child_id, target_date, breakfast, lunch, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(child_id, target_date) DO UPDATE SET
        breakfast = excluded.breakfast,
        lunch = excluded.lunch,
        updated_at = excluded.updated_at
    `).run(childId, targetDate, Number(breakfast), Number(lunch), nowIso());
  }

  registeredParentIds(unansweredFor = null, className = null) {
    const classCondition = className === null ? '' : 'AND c.class_name = ?';
    const condition = unansweredFor
      ? `AND EXISTS (
          SELECT 1 FROM children c
          WHERE c.parent_user_id = p.user_id AND c.active = 1
            ${classCondition}
            AND NOT EXISTS (
              SELECT 1 FROM orders o WHERE o.child_id = c.id AND o.target_date = ?
            )
        )`
      : `AND EXISTS (
          SELECT 1 FROM children c
          WHERE c.parent_user_id = p.user_id AND c.active = 1 ${classCondition}
        )`;
    const statement = this.connection.prepare(
      `SELECT p.user_id FROM parents p WHERE p.active = 1 ${condition}`,
    );
    const parameters = [];
    if (className !== null) parameters.push(className);
    if (unansweredFor) parameters.push(unansweredFor);
    const rows = statement.all(...parameters);
    return rows.map((row) => Number(row.user_id));
  }

  reportRows(targetDate, className = null) {
    const classFilter = className === null ? '' : 'AND c.class_name = ?';
    const statement = this.connection.prepare(`
      SELECT c.class_name, c.child_name,
        COALESCE(o.breakfast, 0) AS breakfast,
        COALESCE(o.lunch, 0) AS lunch
      FROM children c
      JOIN parents p ON p.user_id = c.parent_user_id
      LEFT JOIN orders o ON o.child_id = c.id AND o.target_date = ?
      WHERE p.active = 1 AND c.active = 1 ${classFilter}
      ORDER BY c.class_name, c.child_name COLLATE NOCASE
    `);
    const rows = className === null ? statement.all(targetDate) : statement.all(targetDate, className);
    return rows.map((row) => ({
      className: row.class_name,
      childName: row.child_name,
      breakfast: Boolean(row.breakfast),
      lunch: Boolean(row.lunch),
    }));
  }

  getSettings(keys) {
    const result = {};
    const statement = this.connection.prepare('SELECT value FROM settings WHERE key = ?');
    for (const key of keys) {
      const row = statement.get(key);
      if (row) result[key] = row.value;
    }
    return result;
  }

  setSetting(key, value) {
    this.connection.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, String(value), nowIso());
  }

  deliveryExists(key) {
    return this.connection.prepare('SELECT 1 FROM deliveries WHERE key = ?').get(key) !== undefined;
  }

  recordDelivery(key) {
    this.connection.prepare('INSERT OR IGNORE INTO deliveries (key, delivered_at) VALUES (?, ?)')
      .run(key, nowIso());
  }

  close() {
    this.connection.close();
  }
}
