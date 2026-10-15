/**
 * Authentication and authorization types
 */

/**
 * Authentication response data attached to Express Response.locals
 * Contains authentication context for the current request
 */
export interface AuthResponse {
	/** Authentication method used (JWT cookie or API key) */
	type: 'jwt' | 'apiKey';

	/** User ID (only present for JWT authentication) */
	userId?: string;

	/** Project ID associated with this request */
	projectId: string;

	/** Fork (D37): the scoped API key the request came with; absent for a person or the project's own key. */
	apiKeyId?: string;

	/** Fork (D37): the scoped key's scopes, which list the routes it may call. */
	scopes?: string[];
}

/**
 * Type guard to check if auth is JWT-based
 */
export function isJwtAuth(auth: AuthResponse): auth is AuthResponse & {userId: string} {
	return auth.type === 'jwt' && !!auth.userId;
}

/**
 * Type guard to check if auth is API key-based
 */
export function isApiKeyAuth(auth: AuthResponse): auth is AuthResponse & {userId: undefined} {
	return auth.type === 'apiKey';
}
