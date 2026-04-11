import deploymentSettings from './settings.mjs';
import type { DeploymentSettings } from '../types/settings';

const typedDeploymentSettings = deploymentSettings as DeploymentSettings;

export default typedDeploymentSettings;
