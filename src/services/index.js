'use strict';
const { createUserService } = require('./userService');
const { createProjectService } = require('./projectService');
const { createTaskService } = require('./taskService');

/** Compone i servizi applicativi condivisi da web, bot e worker. */
function createServices({ pool, bus, config, gateway }) {
  const users = createUserService({ pool, config });
  const projects = createProjectService({ pool, bus, config, users, gateway });
  const tasks = createTaskService({ pool, bus, gateway });
  return { pool, users, projects, tasks };
}

module.exports = { createServices };
