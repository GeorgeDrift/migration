const opts = { timestamps: false, freezeTableName: true };

function defineCustomer(sequelize, DataTypes) {
  return sequelize.define('mig_customers', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(120), allowNull: false },
    email: { type: DataTypes.STRING(190), allowNull: false, unique: true },
    loyalty_tier: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'standard' },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.literal('CURRENT_TIMESTAMP') },
  }, { ...opts, tableName: 'mig_customers' });
}

function defineProduct(sequelize, DataTypes) {
  return sequelize.define('mig_products', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    sku: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    title: { type: DataTypes.STRING(160), allowNull: false },
    price_cents: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    discontinued_at: { type: DataTypes.DATE, allowNull: true },
  }, { ...opts, tableName: 'mig_products' });
}

function defineAddress(sequelize, DataTypes) {
  const model = sequelize.define('mig_addresses', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    customer_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    city: { type: DataTypes.STRING(100), allowNull: false },
    postal_code: { type: DataTypes.STRING(20), allowNull: false },
    delivery_instructions: { type: DataTypes.STRING(255), allowNull: true },
  }, { ...opts, tableName: 'mig_addresses', indexes: [{ fields: ['customer_id'] }] });
  model.associate = db => model.belongsTo(db.mig_customers, { foreignKey: 'customer_id', as: 'customer' });
  return model;
}

function defineOrder(sequelize, DataTypes) {
  const model = sequelize.define('mig_orders', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    customer_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    order_status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'new' },
    fulfillment_status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pending' },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.literal('CURRENT_TIMESTAMP') },
  }, { ...opts, tableName: 'mig_orders', indexes: [{ fields: ['customer_id'] }, { fields: ['fulfillment_status'] }] });
  model.associate = db => model.belongsTo(db.mig_customers, { foreignKey: 'customer_id', as: 'customer' });
  return model;
}

function defineOrderItem(sequelize, DataTypes) {
  const model = sequelize.define('mig_order_items', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    order_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    product_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    quantity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    unit_price_cents: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    discount_cents: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
  }, { ...opts, tableName: 'mig_order_items', indexes: [{ fields: ['order_id'] }, { fields: ['product_id'] }] });
  model.associate = db => {
    model.belongsTo(db.mig_orders, { foreignKey: 'order_id', as: 'order' });
    model.belongsTo(db.mig_products, { foreignKey: 'product_id', as: 'product' });
  };
  return model;
}

function definePayment(sequelize, DataTypes) {
  const model = sequelize.define('mig_payments', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    order_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    amount_cents: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    payment_status: { type: DataTypes.STRING(24), allowNull: false },
    provider_reference: { type: DataTypes.STRING(80), allowNull: true, unique: true },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: sequelize.literal('CURRENT_TIMESTAMP') },
  }, { ...opts, tableName: 'mig_payments', indexes: [{ fields: ['order_id'] }] });
  model.associate = db => model.belongsTo(db.mig_orders, { foreignKey: 'order_id', as: 'order' });
  return model;
}

function defineShipment(sequelize, DataTypes) {
  const model = sequelize.define('mig_shipments', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    order_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    address_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    shipment_status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'queued' },
    tracking_code: { type: DataTypes.STRING(96), allowNull: true, unique: true },
  }, { ...opts, tableName: 'mig_shipments', indexes: [{ fields: ['order_id'] }, { fields: ['address_id'] }] });
  model.associate = db => {
    model.belongsTo(db.mig_orders, { foreignKey: 'order_id', as: 'order' });
    model.belongsTo(db.mig_addresses, { foreignKey: 'address_id', as: 'address' });
  };
  return model;
}

module.exports = {
  defineCustomer, defineProduct, defineAddress, defineOrder,
  defineOrderItem, definePayment, defineShipment,
};
