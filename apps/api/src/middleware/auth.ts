import dayjs from 'dayjs';
import type {NextFunction, Request, Response} from 'express';
import jsonwebtoken from 'jsonwebtoken';

import type {Project} from '@plunk/db';
import type {AuthResponse} from '@plunk/types';

import {JWT_SECRET, PLUNK_ENABLED} from '../app/constants.js';
import {ErrorCode, HttpException, NotAuthenticated} from '../exceptions/index.js';
import {ApiKeyService} from '../services/ApiKeyService.js';
import {assertScopedRoute} from '../services/ApiKeyScopes.js';
import {MembershipService} from '../services/MembershipService.js';
import {ProjectService} from '../services/ProjectService.js';
import {UserService} from '../services/UserService.js';

/**
 * Middleware to check if this unsubscribe is authenticated on the dashboard
 * @param req
 * @param res
 * @param next
 */
export const isAuthenticated = (req: Request, res: Response, next: NextFunction) => {
  res.locals.auth = {type: 'jwt', userId: parseJwt(req)};

  next();
};

export const jwt = {
  /**
   * Extracts a unsubscribe id from a jwt
   * @param token The JWT token
   */
  verify(token: string): string | null {
    try {
      const verified = jsonwebtoken.verify(token, JWT_SECRET) as {
        id: string;
      };
      return verified.id;
    } catch {
      return null;
    }
  },
  /**
   * Signs a JWT token
   * @param id The user's ID to sign into a jwt token
   */
  sign(id: string): string {
    return jsonwebtoken.sign({id}, JWT_SECRET, {
      expiresIn: '168h',
    });
  },
  /**
   * Find out when a JWT expires
   * @param token The user's jwt token
   */
  expires(token: string): dayjs.Dayjs {
    const {exp} = jsonwebtoken.verify(token, JWT_SECRET) as {
      exp?: number;
    };
    return dayjs(exp);
  },
};

/**
 * Parse a user's ID from the request JWT token
 * @param request The express request object
 */
export function parseJwt(request: Request): string {
  const token: string | undefined = request.cookies.next_token;

  if (!token) {
    throw new NotAuthenticated();
  }

  const id = jwt.verify(token);

  if (!id) {
    throw new NotAuthenticated();
  }

  return id;
}

/**
 * Fork (D37): the project a secret key opens, with the request's auth. A project's own key opens every route; a
 * scoped key only the routes its scopes grant, which the middleware checks once the rest of auth has passed.
 */
async function projectForSecretKey(apiKey: string): Promise<{project: Project; auth: AuthResponse} | null> {
  if (ApiKeyService.isScoped(apiKey)) {
    const scoped = await ApiKeyService.authenticate(apiKey);
    return (
      scoped && {
        project: scoped.project,
        auth: {type: 'apiKey', projectId: scoped.project.id, apiKeyId: scoped.key.id, scopes: scoped.key.scopes},
      }
    );
  }
  const project = await ProjectService.secret(apiKey);
  return project && {project, auth: {type: 'apiKey', projectId: project.id}};
}

/**
 * Middleware to require public API key authentication (for /v1/track endpoint only)
 * Validates that the request has a valid public key and sets the project
 * @param req
 * @param res
 * @param next
 */
export const requirePublicKey = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Get API key from Authorization header
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      throw new HttpException(401, 'Authorization header is required', ErrorCode.MISSING_AUTH);
    }

    // Support "Bearer <key>" format
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      throw new HttpException(
        401,
        'Authorization header must use Bearer token format: "Authorization: Bearer YOUR_API_KEY"',
        ErrorCode.MISSING_AUTH,
      );
    }

    const apiKey = parts[1];

    if (!apiKey) {
      throw new HttpException(401, 'API key is required in Authorization header', ErrorCode.MISSING_AUTH);
    }

    // Look up project by public key only
    const project = await ProjectService.public(apiKey);

    if (!project) {
      throw new HttpException(
        401,
        'Invalid public API key. Ensure you are using a public key (pk_*) for this endpoint.',
        ErrorCode.INVALID_API_KEY,
      );
    }

    // Set auth response with project ID (before disabled check so it's available for logging)
    res.locals.auth = {
      type: 'apiKey',
      projectId: project.id,
    };

    // Check if project is disabled - block write operations
    if (project.disabled) {
      const method = req.method.toUpperCase();
      const isWriteOperation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);

      if (isWriteOperation) {
        throw new HttpException(
          403,
          'This project has been disabled. Please contact support for assistance.',
          ErrorCode.PROJECT_DISABLED,
        );
      }
    }

    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Middleware to require secret API key authentication
 * Validates that the request has a valid secret key and sets the project
 * @param req
 * @param res
 * @param next
 */
export const requireSecretKey = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Get API key from Authorization header
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      throw new HttpException(401, 'Authorization header is required', ErrorCode.MISSING_AUTH);
    }

    // Support "Bearer <key>" format
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      throw new HttpException(
        401,
        'Authorization header must use Bearer token format: "Authorization: Bearer YOUR_API_KEY"',
        ErrorCode.MISSING_AUTH,
      );
    }

    const apiKey = parts[1];

    if (!apiKey) {
      throw new HttpException(401, 'API key is required in Authorization header', ErrorCode.MISSING_AUTH);
    }

    // Look up project by secret key only; fork (D37): the project's own, or a scoped key
    const resolved = await projectForSecretKey(apiKey);

    if (!resolved) {
      throw new HttpException(
        401,
        'Invalid secret API key. This endpoint requires a secret key (sk_*), not a public key.',
        ErrorCode.INVALID_API_KEY,
      );
    }
    const {project} = resolved;

    // Set auth response with project ID (before disabled check so it's available for logging)
    res.locals.auth = resolved.auth;

    // Check if project is disabled - block write operations
    if (project.disabled) {
      const method = req.method.toUpperCase();
      const isWriteOperation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);

      if (isWriteOperation) {
        throw new HttpException(
          403,
          'This project has been disabled. Please contact support for assistance.',
          ErrorCode.PROJECT_DISABLED,
        );
      }
    }

    // Fork (D37): a scoped key reaches only the routes its scopes grant.
    if (resolved.auth.scopes) {
      await assertScopedRoute(req, project.id, resolved.auth.scopes);
    }

    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Middleware to require authentication - supports both JWT and secret API key
 * For JWT: requires X-Project-Id header and validates user has access to the project
 * For API key: only accepts secret keys (sk_*), derives project from the key
 * @param req
 * @param res
 * @param next
 */
export const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Check for API key first (Authorization header with Bearer token)
    const authHeader = req.headers.authorization;

    // If Authorization header is provided, use secret key authentication
    if (authHeader) {
      // Support "Bearer <key>" format
      const parts = authHeader.split(' ');
      if (parts.length !== 2 || parts[0] !== 'Bearer') {
        throw new HttpException(
          401,
          'Authorization header must use Bearer token format: "Authorization: Bearer YOUR_API_KEY"',
          ErrorCode.MISSING_AUTH,
        );
      }

      const apiKey = parts[1];

      if (!apiKey) {
        throw new HttpException(401, 'API key is required in Authorization header', ErrorCode.MISSING_AUTH);
      }
      // Look up project by secret key only (public keys not allowed); fork (D37): the project's own, or a scoped key
      const resolved = await projectForSecretKey(apiKey);

      if (!resolved) {
        throw new HttpException(
          401,
          'Invalid secret API key. This endpoint requires a secret key (sk_*), not a public key.',
          ErrorCode.INVALID_API_KEY,
        );
      }
      const {project} = resolved;

      // Set auth response with project ID (before disabled check so it's available for logging)
      res.locals.auth = resolved.auth;

      // Check if project is disabled - block write operations
      if (project.disabled) {
        const method = req.method.toUpperCase();
        const isWriteOperation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);

        if (isWriteOperation) {
          throw new HttpException(
            403,
            'This project has been disabled. Please contact support for assistance.',
            ErrorCode.PROJECT_DISABLED,
          );
        }
      }

      // Fork (D37): a scoped key reaches only the routes its scopes grant.
      if (resolved.auth.scopes) {
        await assertScopedRoute(req, project.id, resolved.auth.scopes);
      }

      return next();
    }

    // Otherwise, use JWT authentication
    const userId = parseJwt(req);

    // Get project ID from header (required for JWT auth)
    const projectId = req.headers['x-project-id'] as string | undefined;

    if (!projectId) {
      throw new HttpException(400, 'Project ID is required in X-Project-Id header', ErrorCode.BAD_REQUEST);
    }

    // Verify user has access to this project and get project status
    const [membership, project] = await Promise.all([
      MembershipService.getMembership(userId, projectId),
      ProjectService.id(projectId),
    ]);

    if (!membership) {
      throw new HttpException(403, 'You do not have access to this project', ErrorCode.PROJECT_ACCESS_DENIED);
    }

    // Set auth response with project ID (before disabled check so it's available for logging)
    res.locals.auth = {
      type: 'jwt',
      userId,
      projectId,
    };

    // Check if project is disabled - block write operations
    if (project?.disabled) {
      const method = req.method.toUpperCase();
      const isWriteOperation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);

      if (isWriteOperation) {
        throw new HttpException(
          403,
          'This project has been disabled. Please contact support for assistance.',
          ErrorCode.PROJECT_DISABLED,
        );
      }
    }

    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Middleware to require email verification
 * Must be used AFTER isAuthenticated or requireProjectAccess
 * @param req
 * @param res
 * @param next
 */
export const requireEmailVerified = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = res.locals.auth;

    if (auth.type === 'apiKey') {
      return next();
    }

    if (!auth.userId) {
      throw new NotAuthenticated();
    }

    const user = await UserService.id(auth.userId);

    if (!user) {
      throw new NotAuthenticated();
    }

    // If platform email verification is disabled, skip check
    if (!PLUNK_ENABLED) {
      return next();
    }

    // OAuth users are always considered verified
    if (user.type !== 'PASSWORD') {
      return next();
    }

    // PASSWORD users must verify email
    if (!user.emailVerified) {
      throw new HttpException(
        403,
        'Please verify your email address to access this resource',
        ErrorCode.EMAIL_VERIFICATION_REQUIRED,
      );
    }

    next();
  } catch (error) {
    next(error);
  }
};
