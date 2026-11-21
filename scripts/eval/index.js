'use strict';

const measure = require('./measure');
const suite = require('./suite');
const smoke = require('./smoke');
const dashboardApi = require('./dashboard-api');
const commands = require('./commands');
const score = require('./score');
const gate = require('./gate');
const report = require('./report');
const rubric = require('./rubric');
const improve = require('./improve');

module.exports = {
  ...measure,
  ...suite,
  ...smoke,
  ...dashboardApi,
  ...commands,
  ...score,
  ...gate,
  ...report,
  ...rubric,
  ...improve,
};
