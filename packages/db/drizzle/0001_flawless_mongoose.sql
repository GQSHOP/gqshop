ALTER TABLE "gq_order" ADD COLUMN "idempotency_key" varchar(64);--> statement-breakpoint
CREATE UNIQUE INDEX "gq_order_out_trade_no" ON "gq_order" USING btree ("out_trade_no");--> statement-breakpoint
CREATE UNIQUE INDEX "gq_order_idempotency_key" ON "gq_order" USING btree ("idempotency_key");