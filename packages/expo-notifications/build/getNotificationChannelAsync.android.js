import { UnavailabilityError } from 'expo/internal';
import NotificationChannelManager from './NotificationChannelManager';
export default async function getNotificationChannelAsync(channelId) {
    if (!NotificationChannelManager.getNotificationChannelAsync) {
        throw new UnavailabilityError('Notifications', 'getNotificationChannelAsync');
    }
    return await NotificationChannelManager.getNotificationChannelAsync(channelId);
}
//# sourceMappingURL=getNotificationChannelAsync.android.js.map
