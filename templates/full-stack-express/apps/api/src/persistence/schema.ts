import { sql } from 'drizzle-orm';
import {
  check,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

// Unrelated to Apex's own app_users table. This is the starter's one example.
export const appUsers = pgTable(
  'app_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    externalSubject: varchar('external_subject', { length: 255 }).notNull(),
    displayName: varchar('display_name', { length: 100 }).notNull(),
    email: varchar('email', { length: 254 }),
    status: text('status', { enum: ['active', 'disabled'] })
      .notNull()
      .default('active'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('app_users_external_subject_unique').on(table.externalSubject),
    check(
      'app_users_status_check',
      sql`${table.status} in ('active', 'disabled')`
    ),
  ]
);
