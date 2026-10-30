'use client';

import { onlineManager } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

/**
 * The host says whether its gateway answers. While it does not, reads wait instead of failing,
 * and the screens keep what was kept; when it answers again they go on and bring in what is new.
 * The browser's own online events are left out: they speak of the network, not of the gateway.
 * Set before the first read, so a gateway known to be away is not asked at all.
 */
export function useGatewayOnline(online: boolean): void {
  useState(() => {
    onlineManager.setEventListener(() => () => {});
    onlineManager.setOnline(online);
  });
  useEffect(() => onlineManager.setOnline(online), [online]);
}
