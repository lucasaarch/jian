/** The gateway's own zone, for a profile that never said where its owner lives. */
export const gatewayTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
