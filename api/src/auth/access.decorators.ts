/* Route access metadata read by AccessGuard. */
import { SetMetadata } from '@nestjs/common';

export const ACCESS_KEY = 'gym:access';

export type AccessLevel = 'public' | 'optional' | 'session' | 'admin' | 'owner';

/** No session needed (health, config, sign-in, pairing, media read is session-only). */
export const Public = () => SetMetadata(ACCESS_KEY, 'public' as AccessLevel);

/** The handler accepts a session when there is one, but does not require it. */
export const OptionalSession = () => SetMetadata(ACCESS_KEY, 'optional' as AccessLevel);

/** Requires a valid session; the default when no metadata is present. */
export const SessionRequired = () => SetMetadata(ACCESS_KEY, 'session' as AccessLevel);

/** Requires an admin; a plain member is audited and refused. */
export const AdminOnly = () => SetMetadata(ACCESS_KEY, 'admin' as AccessLevel);

/** Requires the instance owner. */
export const OwnerOnly = () => SetMetadata(ACCESS_KEY, 'owner' as AccessLevel);
