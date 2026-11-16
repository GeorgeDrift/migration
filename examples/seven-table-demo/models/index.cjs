const { DataTypes, Sequelize } = require('sequelize');
const definitions = require('./definitions.cjs');

// This instance is for local model inspection; the Atlas provider creates its own.
const sequelize = new Sequelize('benchmark', 'unused', 'unused', {
  dialect: 'mariadb', logging: false,
});
const models = Object.values(definitions).map(define => define(sequelize, DataTypes));
const byName = Object.fromEntries(models.map(model => [model.name, model]));
for (const model of models) model.associate?.(byName);

module.exports = { sequelize, ...byName };
