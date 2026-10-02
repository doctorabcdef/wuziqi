import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';

export const game = sqliteTable('game', {
  id: integer('id').primaryKey(),
  revision: integer('revision').notNull().default(0),
  state: text('state').notNull(),
});
