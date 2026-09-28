// In a consuming project, import the SDK types from `guardian-daemon-sdk/core`.

import type { ScreeningProvider, ScreeningRequest, ScreeningResult } from '../src/core/index.ts';

/**
 * Missing [screening policy](../docs/guardian-specification.md#screening-provider) leaves every
 * requested anchor incomplete.
 */
export class UnconfiguredScreening implements ScreeningProvider {
  screen(request: ScreeningRequest): Promise<readonly ScreeningResult[]> {
    return Promise.resolve(request.anchors.map(() => ({ status: 'incomplete' })));
  }
}

// Replace this placeholder with your provider and its configuration when adapting the example.
export const screening: ScreeningProvider = new UnconfiguredScreening();
