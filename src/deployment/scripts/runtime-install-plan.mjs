#!/usr/bin/env node
import deploymentSettings from '../settings/settings.mjs';

const services = deploymentSettings.services ?? [];

const runtimeSet = new Set(services.map((service) => service.type));
const pythonFrameworks = [
  ...new Set(
    services
      .filter((service) => service.type === 'python')
      .map((service) => service.pythonFramework)
      .filter(Boolean)
  )
];

const shellSafeFrameworks = pythonFrameworks.join(' ');

process.stdout.write(`NEED_GO=${runtimeSet.has('go') ? 1 : 0}\n`);
process.stdout.write(`NEED_RUST=${runtimeSet.has('rust') ? 1 : 0}\n`);
process.stdout.write(`NEED_PYTHON=${runtimeSet.has('python') ? 1 : 0}\n`);
process.stdout.write(`PYTHON_FRAMEWORKS=\"${shellSafeFrameworks}\"\n`);
