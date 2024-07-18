import { ProxyNativeModule } from 'expo/modules-core';
import { NotificationResponse } from './Notifications.types';
export interface NotificationsEmitterModule extends ProxyNativeModule {
    getLastNotificationResponseAsync?: () => Promise<NotificationResponse | null>;
}
//# sourceMappingURL=NotificationsEmitterModule.types.d.ts.map