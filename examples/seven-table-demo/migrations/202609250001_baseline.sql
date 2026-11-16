-- atlas:txtar
-- migration.sql --
CREATE TABLE `mig_customers` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(120) NOT NULL,
  `email` varchar(190) NOT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `mig_customers_email_unique` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `mig_products` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `sku` varchar(64) NOT NULL,
  `title` varchar(160) NOT NULL,
  `price_cents` int unsigned NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `mig_products_sku_unique` (`sku`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `mig_addresses` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `customer_id` bigint unsigned NOT NULL,
  `city` varchar(100) NOT NULL,
  `postal_code` varchar(20) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `mig_addresses_customer_id_idx` (`customer_id`),
  CONSTRAINT `mig_addresses_customer_fk` FOREIGN KEY (`customer_id`) REFERENCES `mig_customers` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `mig_orders` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `customer_id` bigint unsigned NOT NULL,
  `order_status` varchar(24) NOT NULL DEFAULT 'new',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `mig_orders_customer_id_idx` (`customer_id`),
  CONSTRAINT `mig_orders_customer_fk` FOREIGN KEY (`customer_id`) REFERENCES `mig_customers` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `mig_order_items` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `order_id` bigint unsigned NOT NULL,
  `product_id` bigint unsigned NOT NULL,
  `quantity` int unsigned NOT NULL,
  `unit_price_cents` int unsigned NOT NULL,
  PRIMARY KEY (`id`),
  KEY `mig_order_items_order_id_idx` (`order_id`),
  KEY `mig_order_items_product_id_idx` (`product_id`),
  CONSTRAINT `mig_order_items_order_fk` FOREIGN KEY (`order_id`) REFERENCES `mig_orders` (`id`),
  CONSTRAINT `mig_order_items_product_fk` FOREIGN KEY (`product_id`) REFERENCES `mig_products` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `mig_payments` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `order_id` bigint unsigned NOT NULL,
  `amount_cents` int unsigned NOT NULL,
  `payment_status` varchar(24) NOT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `mig_payments_order_id_idx` (`order_id`),
  CONSTRAINT `mig_payments_order_fk` FOREIGN KEY (`order_id`) REFERENCES `mig_orders` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `mig_shipments` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `order_id` bigint unsigned NOT NULL,
  `address_id` bigint unsigned NOT NULL,
  `shipment_status` varchar(24) NOT NULL DEFAULT 'queued',
  PRIMARY KEY (`id`),
  KEY `mig_shipments_order_id_idx` (`order_id`),
  KEY `mig_shipments_address_id_idx` (`address_id`),
  CONSTRAINT `mig_shipments_order_fk` FOREIGN KEY (`order_id`) REFERENCES `mig_orders` (`id`),
  CONSTRAINT `mig_shipments_address_fk` FOREIGN KEY (`address_id`) REFERENCES `mig_addresses` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- down.sql --
DROP TABLE `mig_shipments`;
DROP TABLE `mig_payments`;
DROP TABLE `mig_order_items`;
DROP TABLE `mig_orders`;
DROP TABLE `mig_addresses`;
DROP TABLE `mig_products`;
DROP TABLE `mig_customers`;
