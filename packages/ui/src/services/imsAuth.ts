/*
 * IMS Auth Service (standalone only)
 * Ported from EMC. Dynamically loads Adobe's imslib.min.js and creates an IMS
 * instance via `window.adobeImsFactory.createIMSLib(config, 'adobeIMS')`.
 *
 * PIM is always standalone (there is no ExC Shell host), so the shell branch
 * from EMC is trimmed out. Profile mapping is kept so the UI can show the
 * signed-in email/name.
 */

import { env } from "../config/env";

export interface AdobeIMSTokenObject {
  token: string;
  expire: Date | string;
  sid?: string;
}

export interface AdobeIMSProfile {
  userId?: string;
  displayName?: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  account_type?: string;
  ownerOrg?: string;
  [key: string]: unknown;
}

export interface AdobeIMS {
  initialize(): Promise<void>;
  signIn(): Promise<void>;
  signOut(params?: Record<string, string>): void;
  getAccessToken(): AdobeIMSTokenObject | null;
  getProfile(): Promise<AdobeIMSProfile>;
  isSignedInUser(): boolean;
}

interface AdobeIdConfig {
  client_id: string;
  scope?: string;
  environment?: string;
  redirect_uri?: string;
  useLocalStorage?: boolean;
  logsEnabled?: boolean;
  onReady?: () => void;
  onAccessToken?: (token: AdobeIMSTokenObject) => void;
  onReauthAccessToken?: (token: AdobeIMSTokenObject) => void;
  onAccessTokenHasExpired?: () => void;
  onError?: (type: string, message: string, details?: unknown) => void;
}

declare global {
  interface Window {
    adobeIMS?: AdobeIMS;
    adobeImsFactory?: {
      createIMSLib: (config: AdobeIdConfig | null, instanceName?: string) => AdobeIMS;
    };
    adobeid?: AdobeIdConfig;
  }
}

export interface PimIms {
  token: string;
  profile?: {
    userId?: string;
    name?: string;
    email?: string;
  };
}

const IMS_LIB_CDN_URL = "https://auth.services.adobe.com/imslib/imslib.min.js";
const IMS_SCRIPT_ID = "adobe-imslib-script";

type AuthStateListener = (ims: PimIms | null) => void;

class ImsAuthService {
  private scriptLoadPromise: Promise<void> | null = null;
  private initializePromise: Promise<void> | null = null;
  private listeners: AuthStateListener[] = [];
  private currentIms: PimIms | null = null;

  private loadScript(): Promise<void> {
    if (this.scriptLoadPromise) return this.scriptLoadPromise;

    if (typeof window.adobeImsFactory !== "undefined") {
      this.scriptLoadPromise = Promise.resolve();
      return this.scriptLoadPromise;
    }

    this.scriptLoadPromise = new Promise<void>((resolve, reject) => {
      const existing = document.getElementById(IMS_SCRIPT_ID) as HTMLScriptElement | null;
      if (existing) {
        if (typeof window.adobeImsFactory !== "undefined") {
          resolve();
          return;
        }
        existing.addEventListener("load", () => this.waitForFactory(resolve, reject));
        existing.addEventListener("error", () =>
          reject(new Error(`Failed to load Adobe IMS library from CDN: ${IMS_LIB_CDN_URL}`)),
        );
        return;
      }

      const script = document.createElement("script");
      script.id = IMS_SCRIPT_ID;
      script.src = IMS_LIB_CDN_URL;
      script.type = "text/javascript";
      script.onload = () => this.waitForFactory(resolve, reject);
      script.onerror = () =>
        reject(new Error(`Failed to load Adobe IMS library from: ${IMS_LIB_CDN_URL}`));
      document.head.appendChild(script);
    });

    return this.scriptLoadPromise;
  }

  private waitForFactory(resolve: () => void, reject: (err: Error) => void): void {
    if (typeof window.adobeImsFactory !== "undefined") {
      resolve();
      return;
    }
    let attempts = 0;
    const poll = setInterval(() => {
      attempts++;
      if (typeof window.adobeImsFactory !== "undefined") {
        clearInterval(poll);
        resolve();
      } else if (attempts >= 20) {
        clearInterval(poll);
        reject(new Error("Adobe IMS script loaded but window.adobeImsFactory is missing"));
      }
    }, 100);
  }

  private isLibraryAvailable(): boolean {
    return typeof window !== "undefined" && typeof window.adobeIMS !== "undefined";
  }

  initialize(onAccessToken?: (ims: PimIms) => void): Promise<void> {
    if (this.initializePromise) return this.initializePromise;

    this.initializePromise = this.loadScript().then(() => {
      return new Promise<void>((resolve) => {
        const imsConfig: AdobeIdConfig = {
          client_id: env.imsClientId,
          scope: env.imsScopes,
          environment: env.imsEnv,
          useLocalStorage: false,
          logsEnabled: false,
          redirect_uri: window.location.origin + window.location.pathname,

          onReady: () => {
            this.checkExistingSession(onAccessToken);
            resolve();
          },
          onAccessToken: (t) => this.handleTokenReceived(t, onAccessToken),
          onReauthAccessToken: (t) => this.handleTokenReceived(t, onAccessToken),
          onAccessTokenHasExpired: () => {
            this.currentIms = null;
            this.notifyListeners(null);
          },
          onError: (type, message, details) => {
            console.error(`IMS error [${type}]: ${message}`, details ?? "");
            resolve();
          },
        };

        try {
          window.adobeImsFactory!.createIMSLib(imsConfig, "adobeIMS");
          window.adobeIMS!.initialize();
        } catch (err) {
          console.error("IMS: failed to create/initialize instance", err);
          resolve();
        }
      });
    });

    return this.initializePromise;
  }

  private async checkExistingSession(cb?: (ims: PimIms) => void): Promise<void> {
    if (!this.isLibraryAvailable()) return;
    try {
      if (!window.adobeIMS!.isSignedInUser()) return;
      const tokenObj = window.adobeIMS!.getAccessToken();
      if (!tokenObj) return;
      await this.handleTokenReceived(tokenObj, cb);
    } catch {
      // session check failed silently
    }
  }

  async getCurrentIms(): Promise<PimIms | null> {
    if (!this.isLibraryAvailable()) return null;
    if (!window.adobeIMS!.isSignedInUser()) return null;
    const tokenObj = window.adobeIMS!.getAccessToken();
    if (!tokenObj) return null;
    const profile = await this.fetchProfile();
    const ims: PimIms = { token: tokenObj.token, profile: this.mapProfile(profile) };
    this.currentIms = ims;
    return ims;
  }

  signIn(): void {
    if (this.isLibraryAvailable()) {
      window.adobeIMS!.signIn();
      return;
    }
    this.initialize()
      .then(() => {
        if (this.isLibraryAvailable()) window.adobeIMS!.signIn();
      })
      .catch((err) => console.error("IMS: could not load library for sign-in", err));
  }

  signOut(): void {
    if (!this.isLibraryAvailable()) return;
    this.currentIms = null;
    this.notifyListeners(null);
    window.adobeIMS!.signOut();
  }

  getCachedIms(): PimIms | null {
    return this.currentIms;
  }

  onAuthStateChange(listener: AuthStateListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private async handleTokenReceived(
    tokenObj: AdobeIMSTokenObject,
    cb?: (ims: PimIms) => void,
  ): Promise<void> {
    try {
      const profile = await this.fetchProfile();
      const ims: PimIms = { token: tokenObj.token, profile: this.mapProfile(profile) };
      this.currentIms = ims;
      this.notifyListeners(ims);
      cb?.(ims);
    } catch {
      const ims: PimIms = { token: tokenObj.token };
      this.currentIms = ims;
      this.notifyListeners(ims);
      cb?.(ims);
    }
  }

  private mapProfile(profile: AdobeIMSProfile | null): PimIms["profile"] {
    if (!profile) return undefined;
    const name =
      profile.displayName ||
      `${profile.first_name ?? ""} ${profile.last_name ?? ""}`.trim() ||
      undefined;
    return {
      userId: profile.userId,
      name,
      email: profile.email,
    };
  }

  private async fetchProfile(): Promise<AdobeIMSProfile | null> {
    if (!this.isLibraryAvailable()) return null;
    try {
      return await window.adobeIMS!.getProfile();
    } catch {
      return null;
    }
  }

  private notifyListeners(ims: PimIms | null): void {
    this.listeners.forEach((l) => {
      try {
        l(ims);
      } catch (err) {
        console.error("IMS: auth state listener error", err);
      }
    });
  }
}

export const imsAuthService = new ImsAuthService();
export default imsAuthService;
