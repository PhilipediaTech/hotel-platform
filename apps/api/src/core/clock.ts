/** Current time. Injected so tests can move time (lockouts, session expiry, token expiry). */
export type Clock = () => Date;

export const systemClock: Clock = () => new Date();
