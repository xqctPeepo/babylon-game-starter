/** @type {import('../types/settings').DeploymentSettings<'render.com'>} */
const deploymentSettings = {
  host: 'render.com',
  type: 'web-service',
  services: [
    {
      name: 'api',
      type: 'node',
      routePrefix: '/api',
      localPort: 8787
    }
  ],
  static: {
    basePath: '/'
  }
};

export default deploymentSettings;
