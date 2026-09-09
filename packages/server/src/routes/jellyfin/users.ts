import { Router, type Request } from 'express';
import {
  createLogger,
  encryptString,
  isConfigUuid,
  mintToken,
  quickConnectConsume,
  resolveConfigAlias,
  serverId as instanceServerId,
  uuidToUserId,
  type ClientInfo,
  type UserData,
} from '@aiostreams/core';
import {
  jf,
  jfOptional,
  param,
  resolveConfig,
  type JellyfinRequestContext,
} from './context.js';
import { serverName } from './system.js';

const logger = createLogger('jellyfin');
const router: Router = Router({ mergeParams: true });

export function userConfiguration() {
  return {
    PlayDefaultAudioTrack: true,
    SubtitleLanguagePreference: '',
    DisplayMissingEpisodes: false,
    GroupedFolders: [],
    SubtitleMode: 'Default',
    DisplayCollectionsView: false,
    EnableLocalPassword: false,
    OrderedViews: [],
    LatestItemsExcludes: [],
    MyMediaExcludes: [],
    HidePlayedInLatest: true,
    RememberAudioSelections: true,
    RememberSubtitleSelections: true,
    EnableNextEpisodeAutoPlay: true,
    CastReceiverId: '',
  };
}

export function userPolicy() {
  return {
    IsAdministrator: false,
    IsHidden: false,
    EnableCollectionManagement: false,
    EnableSubtitleManagement: false,
    EnableLyricManagement: false,
    IsDisabled: false,
    BlockedTags: [],
    AllowedTags: [],
    EnableUserPreferenceAccess: true,
    AccessSchedules: [],
    BlockUnratedItems: [],
    EnableRemoteControlOfOtherUsers: false,
    EnableSharedDeviceControl: false,
    EnableRemoteAccess: true,
    EnableLiveTvManagement: false,
    EnableLiveTvAccess: false,
    EnableMediaPlayback: true,
    EnableAudioPlaybackTranscoding: false,
    EnableVideoPlaybackTranscoding: false,
    EnablePlaybackRemuxing: false,
    ForceRemoteSourceTranscoding: false,
    EnableContentDeletion: false,
    EnableContentDeletionFromFolders: [],
    EnableContentDownloading: true,
    EnableSyncTranscoding: false,
    EnableMediaConversion: false,
    EnabledDevices: [],
    EnableAllDevices: true,
    EnabledChannels: [],
    EnableAllChannels: true,
    EnabledFolders: [],
    EnableAllFolders: true,
    InvalidLoginAttemptCount: 0,
    LoginAttemptsBeforeLockout: -1,
    MaxActiveSessions: 0,
    EnablePublicSharing: false,
    BlockedMediaFolders: [],
    BlockedChannels: [],
    RemoteClientBitrateLimit: 0,
    AuthenticationProviderId:
      'Jellyfin.Server.Implementations.Users.DefaultAuthenticationProvider',
    PasswordResetProviderId:
      'Jellyfin.Server.Implementations.Users.DefaultPasswordResetProvider',
    SyncPlayAccess: 'None',
  };
}

export function userDto(uuid: string, userData: Pick<UserData, 'addonName'>) {
  const now = new Date().toISOString();
  return {
    Name: userData.addonName || serverName(),
    ServerId: instanceServerId(),
    ServerName: serverName(),
    Id: uuidToUserId(uuid),
    HasPassword: true,
    HasConfiguredPassword: true,
    HasConfiguredEasyPassword: false,
    EnableAutoLogin: true,
    LastLoginDate: now,
    LastActivityDate: now,
    Configuration: userConfiguration(),
    Policy: userPolicy(),
  };
}

export function sessionInfo(
  uuid: string,
  userData: Pick<UserData, 'addonName'>,
  client: ClientInfo,
  remoteIp: string | undefined
) {
  const now = new Date().toISOString();
  return {
    PlayState: {
      CanSeek: true,
      IsPaused: false,
      IsMuted: false,
      RepeatMode: 'RepeatNone',
      PlaybackOrder: 'Default',
    },
    AdditionalUsers: [],
    Capabilities: {
      PlayableMediaTypes: ['Video'],
      SupportedCommands: [],
      SupportsMediaControl: false,
      SupportsPersistentIdentifier: false,
    },
    RemoteEndPoint: remoteIp ?? '',
    PlayableMediaTypes: ['Video'],
    Id: `${uuidToUserId(uuid)}-${client.deviceId}`,
    UserId: uuidToUserId(uuid),
    UserName: userData.addonName || serverName(),
    Client: client.name,
    LastActivityDate: now,
    LastPlaybackCheckIn: new Date(0).toISOString(),
    DeviceName: client.device,
    DeviceId: client.deviceId,
    ApplicationVersion: client.version,
    IsActive: true,
    SupportsMediaControl: false,
    SupportsRemoteControl: false,
    NowPlayingQueue: [],
    HasCustomDeviceName: false,
    ServerId: instanceServerId(),
    SupportedCommands: [],
  };
}

function clientOf(req: Request): ClientInfo {
  return (
    req.jfClient ?? {
      name: 'Unknown',
      device: 'Unknown',
      deviceId: 'unknown',
      version: '0',
    }
  );
}

async function authenticationResult(
  req: Request,
  uuid: string,
  encryptedPassword: string,
  userData: UserData
) {
  const client = clientOf(req);
  return {
    User: userDto(uuid, userData),
    SessionInfo: sessionInfo(uuid, userData, client, req.userIp),
    AccessToken: mintToken({
      u: uuid,
      p: encryptedPassword,
      d: client.deviceId,
    }),
    ServerId: instanceServerId(),
  };
}

router.get(
  '/Users/Public',
  jfOptional(async (req, res, ctx) => {
    if (ctx?.preAuthenticated) {
      res.json([userDto(ctx.uuid, ctx.userData)]);
      return;
    }
    res.json([]);
  })
);

router.post(
  '/Users/AuthenticateByName',
  jfOptional(async (req, res, ctx) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const username = String(body.Username ?? body.username ?? '').trim();
    const pw = String(
      body.Pw ?? body.pw ?? body.Password ?? body.password ?? ''
    );

    let uuid: string | undefined;
    let encryptedPassword: string | undefined;
    if (ctx?.preAuthenticated) {
      uuid = ctx.uuid;
      encryptedPassword = ctx.encryptedPassword;
    } else {
      if (!username) {
        res
          .status(401)
          .json({
            Message: 'Username (configuration UUID or alias) is required',
          });
        return;
      }
      if (isConfigUuid(username)) {
        const enc = encryptString(pw);
        if (!enc.success || !enc.data) {
          res.status(500).json({ Message: 'Encryption failure' });
          return;
        }
        uuid = username;
        encryptedPassword = enc.data;
      } else {
        // an alias already carries its password, the way alias URLs do
        const alias = await resolveConfigAlias(username);
        if (!alias) {
          res.status(401).json({ Message: 'Invalid username or password' });
          return;
        }
        uuid = alias.uuid;
        encryptedPassword = alias.encryptedPassword;
      }
    }

    const userData = await resolveConfig(uuid, encryptedPassword);
    if (!userData) {
      res.status(401).json({ Message: 'Invalid username or password' });
      return;
    }
    const client = clientOf(req);
    logger.info(
      { uuid, client: client.name, device: client.device },
      'jellyfin client authenticated'
    );
    res.json(
      await authenticationResult(req, uuid, encryptedPassword, userData)
    );
  })
);

router.post(
  '/Users/AuthenticateWithQuickConnect',
  jfOptional(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const secret = String(body.Secret ?? body.secret ?? '');
    const entry = secret ? await quickConnectConsume(secret) : null;
    if (!entry?.uuid || !entry.encryptedPassword) {
      res
        .status(401)
        .json({ Message: 'Quick Connect code has not been approved' });
      return;
    }
    const userData = await resolveConfig(entry.uuid, entry.encryptedPassword);
    if (!userData) {
      res.status(401).json({ Message: 'Configuration is no longer valid' });
      return;
    }
    logger.info(
      { uuid: entry.uuid, client: entry.appName, device: entry.deviceName },
      'quick connect sign-in'
    );
    res.json(
      await authenticationResult(
        req,
        entry.uuid,
        entry.encryptedPassword,
        userData
      )
    );
  })
);

router.get(
  '/Users/Me',
  jf(async (_req, res, ctx) => {
    res.json(userDto(ctx.uuid, ctx.userData));
  })
);
router.get(
  '/Users',
  jf(async (_req, res, ctx) => {
    res.json([userDto(ctx.uuid, ctx.userData)]);
  })
);
router.get(
  '/Users/:userId',
  jf(async (_req, res, ctx) => {
    res.json(userDto(ctx.uuid, ctx.userData));
  })
);
router.get(
  '/Users/:userId/Configuration',
  jf(async (_req, res) => {
    res.json(userConfiguration());
  })
);
router.post(
  ['/Users/Configuration', '/Users/:userId/Configuration'],
  jf(async (_req, res) => {
    res.status(204).end();
  })
);
router.post(
  [
    '/Users/Password',
    '/Users/:userId/Password',
    '/Users/:userId/Policy',
    '/Users/:userId/EasyPassword',
  ],
  jf(async (_req, res) => {
    res.status(204).end();
  })
);

router.get(
  '/Sessions',
  jf(async (req, res, ctx) => {
    res.json([sessionInfo(ctx.uuid, ctx.userData, ctx.client, req.userIp)]);
  })
);
router.post(
  [
    '/Sessions/Capabilities',
    '/Sessions/Capabilities/Full',
    '/Sessions/Viewing',
    '/Sessions/Logout',
  ],
  jfOptional(async (_req, res) => {
    res.status(204).end();
  })
);
router.all(
  '/Sessions/:sessionId/{*rest}',
  (req, _res, next) =>
    /^playing$/i.test(String(req.params.sessionId)) ? next('route') : next(),
  jf(async (_req, res) => {
    res.status(204).end();
  })
);

router.get(
  '/Devices',
  jf(async (req, res, ctx) => {
    res.json({
      Items: [
        {
          Name: ctx.client.device,
          Id: ctx.client.deviceId,
          LastUserName: ctx.userData.addonName || serverName(),
          AppName: ctx.client.name,
          AppVersion: ctx.client.version,
          LastUserId: ctx.userId,
          DateLastActivity: new Date().toISOString(),
          Capabilities: {
            PlayableMediaTypes: ['Video'],
            SupportedCommands: [],
            SupportsMediaControl: false,
            SupportsPersistentIdentifier: false,
          },
        },
      ],
      TotalRecordCount: 1,
      StartIndex: 0,
    });
  })
);
router.get(
  '/Devices/Info',
  jf(async (_req, res, ctx) => {
    res.json({
      Name: ctx.client.device,
      Id: ctx.client.deviceId,
      AppName: ctx.client.name,
      AppVersion: ctx.client.version,
    });
  })
);
router.get(
  '/Devices/Options',
  jf(async (_req, res) => {
    res.json({ CustomName: null });
  })
);
router.post(
  '/Devices/Options',
  jf(async (_req, res) => {
    res.status(204).end();
  })
);

export type { JellyfinRequestContext };
export { param };
export default router;
