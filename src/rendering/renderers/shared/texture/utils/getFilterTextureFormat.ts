import type { TEXTURE_FORMATS } from '../const';

/**
 * Keeps floating colour range while allowing sampled-only formats to use the default render target.
 * @param format - The sampled texture's format.
 * @internal
 */
export function getFilterTextureFormat(format: TEXTURE_FORMATS): TEXTURE_FORMATS | undefined
{
    return format === 'rgba16float' ? format : undefined;
}
