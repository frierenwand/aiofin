import { Router } from 'express';
import { z } from 'zod';
import {
  APIError,
  config as appConfig,
  constants,
  createLogger,
  encryptString,
  PlaybackHandoffRepository,
  quickConnectAuthorize,
  UserRepository,
} from '@aiostreams/core';
import { userApiRateLimiter } from '../../middlewares/ratelimit.js';
import { attachSession } from '../../middlewares/auth.js';
import { resolveConfigCredentials } from '../../utils/basic-auth.js';
import { createResponse } from '../../utils/responses.js';

const logger = createLogger('jellyfin');
const router: Router = Router();

router.use(userApiRateLimiter);
router.use(attachSession);

const approveBody = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Quick Connect codes are six digits'),
});

router.get('/info', (req, res) => {
  const origin =
    appConfig.bootstrap.baseUrl?.replace(/\/$/, '') ||
    `${req.protocol}://${req.get('host')}`;
  res.json(
    createResponse({
      success: true,
      data: {
        enabled: appConfig.jellyfin.enabled === true,
        serverUrl: `${origin}/jellyfin`,
        version: appConfig.jellyfin.version,
        maxVersions: appConfig.jellyfin.maxVersions,
        resolveOnOpen: appConfig.jellyfin.resolveOnOpen,
      },
    })
  );
});

/* Binds a code shown on a TV to the configuration the caller is signed in to. */
router.post('/quickconnect/approve', async (req, res, next) => {
  try {
    if (!appConfig.jellyfin.enabled) {
      next(
        new APIError(
          constants.ErrorCode.FORBIDDEN,
          undefined,
          'Jellyfin API is disabled'
        )
      );
      return;
    }
    const parsed = approveBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      next(
        new APIError(
          constants.ErrorCode.MISSING_REQUIRED_FIELDS,
          undefined,
          parsed.error.issues[0]?.message ?? 'code is required'
        )
      );
      return;
    }
    const creds = await resolveConfigCredentials(req, res, {
      allowEncrypted: true,
    });
    if (!creds) {
      next(new APIError(constants.ErrorCode.UNAUTHORIZED));
      return;
    }
    await UserRepository.verifyUser(creds.uuid, creds.password);
    const enc = encryptString(creds.password);
    if (!enc.success || !enc.data) {
      next(new APIError(constants.ErrorCode.ENCRYPTION_ERROR));
      return;
    }
    const entry = await quickConnectAuthorize(parsed.data.code, {
      uuid: creds.uuid,
      encryptedPassword: enc.data,
    });
    if (!entry) {
      res.status(404).json(
        createResponse({
          success: false,
          detail: 'Unknown, expired or already approved code',
        })
      );
      return;
    }
    logger.info(
      { uuid: creds.uuid, device: entry.deviceName, app: entry.appName },
      'quick connect code approved'
    );
    res.json(
      createResponse({
        success: true,
        data: {
          approved: true,
          device: {
            name: entry.deviceName,
            app: entry.appName,
            version: entry.appVersion,
          },
        },
      })
    );
  } catch (error) {
    next(
      error instanceof APIError
        ? error
        : new APIError(constants.ErrorCode.INTERNAL_SERVER_ERROR)
    );
  }
});

/* Health of the addons this configuration reports playback to. */
router.get('/playback-sinks', async (req, res, next) => {
  try {
    if (!appConfig.watchState.handoffEnabled) {
      res.json(createResponse({ success: true, data: { sinks: [] } }));
      return;
    }
    const creds = await resolveConfigCredentials(req, res, {
      allowEncrypted: true,
    });
    if (!creds) {
      next(new APIError(constants.ErrorCode.UNAUTHORIZED));
      return;
    }
    await UserRepository.verifyUser(creds.uuid, creds.password);
    const sinks = await PlaybackHandoffRepository.listSinks(creds.uuid);
    res.json(
      createResponse({
        success: true,
        data: {
          sinks: sinks.map((sink) => ({
            addon: sink.addonName ?? sink.addonInstanceId,
            status: sink.status,
            lastPushAt: sink.lastPushAt,
            lastError: sink.lastError,
          })),
        },
      })
    );
  } catch (error) {
    next(
      error instanceof APIError
        ? error
        : new APIError(constants.ErrorCode.INTERNAL_SERVER_ERROR)
    );
  }
});

export default router;
