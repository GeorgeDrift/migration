-- atlas:txtar
-- migration.sql --
ALTER TABLE `mig_customers`
  ADD COLUMN `loyalty_tier` varchar(16) NOT NULL DEFAULT 'standard';

ALTER TABLE `mig_products`
  ADD COLUMN `discontinued_at` datetime NULL;

ALTER TABLE `mig_addresses`
  ADD COLUMN `delivery_instructions` varchar(255) NULL;

ALTER TABLE `mig_orders`
  ADD COLUMN `fulfillment_status` varchar(20) NOT NULL DEFAULT 'pending',
  ADD KEY `mig_orders_fulfillment_status_idx` (`fulfillment_status`);

ALTER TABLE `mig_order_items`
  ADD COLUMN `discount_cents` int unsigned NOT NULL DEFAULT 0;

ALTER TABLE `mig_payments`
  ADD COLUMN `provider_reference` varchar(80) NULL,
  ADD UNIQUE KEY `mig_payments_provider_reference_unique` (`provider_reference`);

ALTER TABLE `mig_shipments`
  ADD COLUMN `tracking_code` varchar(96) NULL,
  ADD UNIQUE KEY `mig_shipments_tracking_code_unique` (`tracking_code`);

-- down.sql --
ALTER TABLE `mig_shipments`
  DROP KEY `mig_shipments_tracking_code_unique`,
  DROP COLUMN `tracking_code`;

ALTER TABLE `mig_payments`
  DROP KEY `mig_payments_provider_reference_unique`,
  DROP COLUMN `provider_reference`;

ALTER TABLE `mig_order_items`
  DROP COLUMN `discount_cents`;

ALTER TABLE `mig_orders`
  DROP KEY `mig_orders_fulfillment_status_idx`,
  DROP COLUMN `fulfillment_status`;

ALTER TABLE `mig_addresses`
  DROP COLUMN `delivery_instructions`;

ALTER TABLE `mig_products`
  DROP COLUMN `discontinued_at`;

ALTER TABLE `mig_customers`
  DROP COLUMN `loyalty_tier`;
