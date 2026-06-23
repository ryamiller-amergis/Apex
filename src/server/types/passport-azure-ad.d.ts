declare module 'passport-azure-ad' {
  import { Strategy } from 'passport';
  
  export interface IOIDCStrategyOptions {
    identityMetadata: string;
    clientID: string;
    clientSecret?: string;
    responseType?: string;
    responseMode?: string;
    redirectUrl: string;
    allowHttpForRedirectUrl?: boolean;
    validateIssuer?: boolean;
    passReqToCallback?: boolean;
    scope?: string[];
    loggingLevel?: 'info' | 'warn' | 'error';
    loggingNoPII?: boolean;
  }

  export class OIDCStrategy extends Strategy {
    constructor(
      options: IOIDCStrategyOptions,
      verify: (iss: any, sub: any, profile: any, accessToken: any, refreshToken: any, done: any) => void
    );
  }
}
