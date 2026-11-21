'use strict';

const measure = require('./measure');
const suite = require('./suite');
const smoke = require('./smoke');
const dashboardApi = require('./dashboard-api');
const commands = require('./commands');

module.exports = {
  ...measure,
  ...suite,
  ...smoke,
  ...dashboardApi,
  ...commands,
};
