import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';

export const game = sqliteTable('game', {
  id: integer('id').primaryKey(),
  revision: integer('revision').notNull().default(0),
  state: text('state').notNull(),
});

export const chatMessages = sqliteTable('chat_messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  requestId: text('request_id').notNull().unique(),
  senderId: text('sender_id').notNull(),
  name: text('name').notNull(),
  text: text('text').notNull(),
  createdAt: text('created_at').notNull(),
});
