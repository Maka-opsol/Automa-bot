'use strict';

const { createContainer } = require('./container-modules');
const {
  startSubsystemGroup,
  startSelfHealV2Subsystems,
  getContainerHealth,
  runStartupSmokeTests,
  spawnWorkers,
  getWorkerStatuses,
  shutdownAll,
} = require('./container-subsystem-runner');

// Create the singleton container instance
const container = createContainer();

module.exports = {
  container,
  // Convenience re-exports
  startSubsystemGroup: (tag: any, method: any) =>
    startSubsystemGroup(container, tag, method),
  startSelfHealV2Subsystems: (CONFIG: any) =>
    startSelfHealV2Subsystems(container, CONFIG),
  getContainerHealth: () =>
    getContainerHealth(container),
  runStartupSmokeTests: () =>
    runStartupSmokeTests(container),
  spawnWorkers: (CONFIG: any) =>
    spawnWorkers(container, CONFIG),
  getWorkerStatuses: () => getWorkerStatuses(),
  shutdownAll: (timeoutMs: any) => shutdownAll(timeoutMs),
};