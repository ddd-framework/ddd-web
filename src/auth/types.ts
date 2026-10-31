/**
 * The token pair a DDD backend issues on login and refresh (`accessToken` + `refreshToken`).
 *
 * The refresh token is a stateless JWT that the backend re-issues with a renewed lifetime on every refresh
 * (no rotation list): storing the newest one is enough.
 */
export interface DddTokens {
  /** Short-lived bearer token sent as `Authorization: Bearer …`. */
  accessToken: string | null;
  /** Long-lived token exchanged for a fresh pair at the refresh endpoint. */
  refreshToken: string | null;
}

/**
 * A partial token update. `undefined` leaves a stored value untouched, `null` removes it.
 */
export interface DddTokensUpdate {
  accessToken?: string | null;
  refreshToken?: string | null;
}

/** Body of the DDD `POST …/common/auth/login` request. */
export interface DddLoginRequest {
  email: string;
  password: string;
}

/** Body of the DDD `POST …/common/auth/refresh` request. */
export interface DddRefreshRequest {
  refreshToken: string;
}

/** Response of the DDD login and refresh endpoints (`AuthPostResponseDto`). */
export interface DddAuthResponse {
  accessToken?: string | null;
  refreshToken?: string | null;
}
