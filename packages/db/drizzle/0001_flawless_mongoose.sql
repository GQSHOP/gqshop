ALTER TABLE "dc_order" ADD COLUMN "idempotency_key" varchar(64);--> statement-breakpoint
CREATE UNIQUE INDEX "dc_order_out_trade_no" ON "dc_order" USING btree ("out_trade_no");--> statement-breakpoint
CREATE UNIQUE INDEX "dc_order_idempotency_key" ON "dc_order" USING btree ("idempotency_key");