export type DeploymentHost = 'github.io' | 'netlify' | 'render.com';
export type DeploymentType = 'web-service' | 'static';
export type ServiceRuntime = 'node' | 'rust' | 'go';

export interface EndpointService {
  name: string;
  type: ServiceRuntime;
  routePrefix: `/${string}`;
  localPort?: number;
}

export interface StaticDeploymentConfig {
  basePath?: `/${string}`;
}

export type HostTypeCompatibility<H extends DeploymentHost> =
  H extends 'github.io' | 'netlify'
    ? { type: 'static' }
    : { type: DeploymentType };

export type DeploymentSettings<H extends DeploymentHost = DeploymentHost> = {
  host: H;
  services: EndpointService[];
  static?: StaticDeploymentConfig;
} & HostTypeCompatibility<H>;
