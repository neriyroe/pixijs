import { isPow2, nextPow2 } from '../../../../maths/misc/pow2';
import { deprecation, v8_21_0 } from '../../../../utils/logging/deprecation';
import { warn } from '../../../../utils/logging/warn';
import { GlobalResourceRegistry } from '../../../../utils/pool/GlobalResourceRegistry';
import { TextureSource } from './sources/TextureSource';
import { Texture } from './Texture';
import { TextureStyle } from './TextureStyle';
import { getFilterTextureFormat } from './utils/getFilterTextureFormat';
import { ScreenSizeRegistry } from './utils/ScreenSizeRegistry';

import type { Size } from '../../../../maths/misc/Size';
import type { SCALE_MODE, TEXTURE_FORMATS } from './const';
import type { TextureSourceOptions } from './sources/TextureSource';

let count = 0;

/** the largest dimension that fits in one of the 15 bit fields of a pool key */
const maxKeyDimension = 32767;

/** << is 32-bit, so format, render use and scale mode ride above the packed size with multiply */
const flagsBit = 0x100000000;

/** the finest step between two size classes, in pixels */
const minClassStep = 32;

const formatIds: Record<string, number> = Object.create(null);
let nextFormatId = 0;

function formatId(format: string): number
{
    const id = formatIds[format];

    if (id !== undefined) return id;

    return (formatIds[format] = nextFormatId++);
}

/** Rounds a size up to its class: four classes an octave (32px steps up to 256), so at most a quarter is spare. */
function sizeClass(pixels: number): number
{
    const step = Math.max(minClassStep, nextPow2(pixels) / 8);

    return Math.ceil(pixels / step) * step;
}

function toPixels(size: number, resolution: number): number
{
    return Math.max(1, Math.ceil((size * resolution) - 1e-6));
}

/**
 * A request for a texture from the pool. `width` and `height` are the minimum frame size the texture must
 * hold; the other fields are the only {@link TextureSourceOptions} the pool honours, and each falls back
 * to the pool's own options. `renderTarget` defaults to true; a texture that only receives uploads asks with false.
 * @category rendering
 * @advanced
 */
export type TexturePoolRequest = Pick<
    TextureSourceOptions,
    'resolution' | 'antialias' | 'autoGenerateMipmaps' | 'format' | 'scaleMode' | 'renderTarget'
> & { width: number, height: number };

// Bits 0-31: antialias, mipmap, height, width. Above them: format id, render use, scale mode.
function sizeBits(width: number, height: number, antialias: boolean, autoGenerateMipmaps: boolean): number
{
    return ((width << 17) | (height << 2) | ((autoGenerateMipmaps ? 1 : 0) << 1) | (antialias ? 1 : 0)) >>> 0;
}

function flagBits(format: TEXTURE_FORMATS, scaleMode: SCALE_MODE, renderTarget: boolean): number
{
    return ((formatId(format) * 4) + (renderTarget ? 2 : 0) + (scaleMode === 'nearest' ? 1 : 0)) * flagsBit;
}

/**
 * Texture pool, used by FilterSystem and plugins.
 *
 * Stores collection of temporary render textures, sized to a class a little above the request or to the screen.
 * Textures are bucketed by size, flags, format, render use and scale mode, so one pool can serve colour, float
 * and depth targets and upload-only textures side by side. Idle textures stay until {@link TexturePoolClass#trim}.
 * @category rendering
 * @advanced
 */
export class TexturePoolClass
{
    /** The default options for texture pool */
    public textureOptions: TextureSourceOptions;

    /** idle textures, keyed by format, render use, scale mode, size and flags */
    private readonly _buckets = new Map<number, Texture[]>();
    /** the bucket key of every texture handed out, by texture uid */
    private _poolKey: Record<number, number> = Object.create(null);
    /** the style the pool created for every texture handed out, by texture uid */
    private _poolStyle: Record<number, TextureStyle> = Object.create(null);
    /** when each idle texture came back to the pool, by texture uid */
    private _idleSince: Record<number, number> = Object.create(null);
    /** the screens this pool is sizing its textures for */
    private readonly _screens = new ScreenSizeRegistry();

    private _textureStyle?: TextureStyle;
    private _enableFullScreen = false;

    /**
     * @param textureOptions - options that will be passed to BaseRenderTexture constructor
     * @param {SCALE_MODE} [textureOptions.scaleMode] - See {@link SCALE_MODE} for possible values.
     */
    constructor(textureOptions?: TextureSourceOptions)
    {
        this.textureOptions = textureOptions || {};
    }

    /**
     * A style built from the pool options. The pool no longer applies it to anything.
     * @deprecated since 8.21.0, pooled textures carry their own style; pass `scaleMode` in the request instead.
     */
    get textureStyle(): TextureStyle
    {
        // #if _DEBUG
        // eslint-disable-next-line max-len
        deprecation(v8_21_0, 'TexturePool.textureStyle is no longer used, pooled textures carry their own style. Pass scaleMode in the request instead.');
        // #endif

        if (!this._textureStyle) this._textureStyle = new TextureStyle(this.textureOptions);

        return this._textureStyle;
    }

    set textureStyle(value: TextureStyle)
    {
        // #if _DEBUG
        // eslint-disable-next-line max-len
        deprecation(v8_21_0, 'TexturePool.textureStyle is no longer used, pooled textures carry their own style. Pass scaleMode in the request instead.');
        // #endif

        this._textureStyle = value;
    }

    /**
     * Has no effect. The pool sizes textures to the screens registered with
     * {@link TexturePoolClass#setScreenSize|setScreenSize}.
     * @deprecated since 8.21.0
     */
    get enableFullScreen(): boolean
    {
        // #if _DEBUG
        // eslint-disable-next-line max-len
        deprecation(v8_21_0, 'TexturePool.enableFullScreen is no longer used, the pool sizes textures to the screens registered with setScreenSize.');
        // #endif

        return this._enableFullScreen;
    }

    set enableFullScreen(value: boolean)
    {
        // #if _DEBUG
        // eslint-disable-next-line max-len
        deprecation(v8_21_0, 'TexturePool.enableFullScreen is no longer used, the pool sizes textures to the screens registered with setScreenSize.');
        // #endif

        this._enableFullScreen = value;
    }

    /**
     * Creates a texture from a request, using the pool constructor options for anything unset.
     * @param options - Width and height are in physical pixels. Format and scale mode fall back to the pool's own.
     */
    public createTexture(options: TexturePoolRequest): Texture;
    /** @deprecated since 8.21.0 */
    public createTexture(
        pixelWidth: number, pixelHeight: number, antialias?: boolean, autoGenerateMipmaps?: boolean
    ): Texture;
    public createTexture(...args: [TexturePoolRequest] | [number, number, boolean?, boolean?]): Texture
    {
        let options = args[0];

        if (typeof options === 'number')
        {
            // #if _DEBUG
            // eslint-disable-next-line max-len
            deprecation(v8_21_0, 'TexturePool.createTexture params are now an options object. See params: { width, height, antialias, autoGenerateMipmaps }');
            // #endif

            options = {
                width: options,
                height: args[1] as number,
                antialias: (args[2] as boolean) ?? false,
                autoGenerateMipmaps: (args[3] as boolean) ?? false,
            };
        }

        const format = options.format ?? this.textureOptions.format ?? TextureSource.defaultOptions.format;
        const scaleMode = options.scaleMode ?? this.textureOptions.scaleMode ?? TextureStyle.defaultOptions.scaleMode;

        const textureSource = new TextureSource({
            ...this.textureOptions,

            width: options.width,
            height: options.height,
            resolution: 1,
            antialias: options.antialias ?? false,
            autoGarbageCollect: false,
            autoGenerateMipmaps: options.autoGenerateMipmaps ?? false,
            format,
            scaleMode,
            renderTarget: options.renderTarget ?? this.textureOptions.renderTarget ?? true,
        });

        return new Texture({
            source: textureSource,
            label: `texturePool_${count++}`,
        });
    }

    /**
     * Gets a render texture sized to the request's class or to a screen.
     *
     * Width and height are the minimum frame size. Resolution, antialias, mipmaps, format and scale
     * mode fall back to 1 / false / the pool's own options. Each format, render use and scale mode keeps its own
     * buckets. An idle texture one class larger on either axis is taken before a new one is made.
     * @param options - The request, using the same fields as {@link TextureSourceOptions}.
     * @returns The new render texture.
     */
    public getOptimalTexture(options: TexturePoolRequest): Texture;
    /** @deprecated since 8.21.0 */
    public getOptimalTexture(
        frameWidth: number, frameHeight: number, resolution?: number, antialias?: boolean, autoGenerateMipmaps?: boolean
    ): Texture;
    public getOptimalTexture(...args: [TexturePoolRequest] | [number, number, number?, boolean?, boolean?]): Texture
    {
        let options = args[0];

        if (typeof options === 'number')
        {
            // #if _DEBUG
            // eslint-disable-next-line max-len
            deprecation(v8_21_0, 'TexturePool.getOptimalTexture params are now an options object. See params: { width, height, resolution, antialias, autoGenerateMipmaps }');
            // #endif

            options = {
                width: options,
                height: args[1] as number,
                resolution: (args[2] as number) ?? 1,
                antialias: (args[3] as boolean) ?? false,
                autoGenerateMipmaps: (args[4] as boolean) ?? false,
            };
        }

        const frameWidth = options.width;
        const frameHeight = options.height;
        const resolution = options.resolution ?? 1;
        const antialias = options.antialias ?? false;
        const autoGenerateMipmaps = options.autoGenerateMipmaps ?? false;
        const format = options.format ?? this.textureOptions.format ?? TextureSource.defaultOptions.format;
        const scaleMode = options.scaleMode ?? this.textureOptions.scaleMode ?? TextureStyle.defaultOptions.scaleMode;
        const renderTarget = options.renderTarget ?? this.textureOptions.renderTarget ?? true;

        const pixelWidth = toPixels(frameWidth, resolution);
        const pixelHeight = toPixels(frameHeight, resolution);
        const textureWidth = this._fitWidth(pixelWidth);
        const textureHeight = this._fitHeight(pixelHeight);

        // #if _DEBUG
        if (textureWidth > maxKeyDimension || textureHeight > maxKeyDimension)
        {
            warn(`TexturePool: ${textureWidth}x${textureHeight} is larger than the `
                + `${maxKeyDimension}px pool key limit, textures of this size may be pooled together`);
        }
        // #endif

        const flags = flagBits(format, scaleMode, renderTarget);
        const key = (width: number, height: number) => sizeBits(width, height, antialias, autoGenerateMipmaps) + flags;
        // a frame that fills its class has no clear border to keep, so it never takes a larger texture
        const wider = textureWidth > pixelWidth ? this._fitWidth(textureWidth + 1) : textureWidth;
        const taller = textureHeight > pixelHeight ? this._fitHeight(textureHeight + 1) : textureHeight;

        let texture = this._takeIdle(key(textureWidth, textureHeight))
            ?? this._takeIdle(key(wider, textureHeight))
            ?? this._takeIdle(key(textureWidth, taller))
            ?? this._takeIdle(key(wider, taller));

        if (!texture)
        {
            const created = key(textureWidth, textureHeight);

            texture = this.createTexture({
                width: textureWidth,
                height: textureHeight,
                antialias,
                autoGenerateMipmaps,
                format,
                scaleMode,
                renderTarget,
            });

            if (!this._buckets.has(created)) this._buckets.set(created, []);
            this._poolKey[texture.uid] = created;
            this._poolStyle[texture.uid] = texture.source.style;
        }

        // a texture keeps its own backing size; only the request decides the frame and resolution
        const source = texture.source;

        source._resolution = resolution;
        source.width = source.pixelWidth / resolution;
        source.height = source.pixelHeight / resolution;

        // fit the layout to the requested original size
        texture.frame.x = 0;
        texture.frame.y = 0;
        texture.frame.width = frameWidth;
        texture.frame.height = frameHeight;

        texture.updateUvs();

        return texture;
    }

    /**
     * The backing size, in physical pixels, that {@link TexturePoolClass#getOptimalTexture|getOptimalTexture}
     * would allocate for a request, without taking a texture from the pool.
     *
     * Each axis is the request's size class (four an octave, so at most a quarter above the request), or the
     * smallest registered screen the request fits inside when that is smaller (see
     * {@link TexturePoolClass#setScreenSize|setScreenSize}). An idle texture one class larger may serve the request.
     * @param frameWidth - The minimum width of the texture.
     * @param frameHeight - The minimum height of the texture.
     * @param resolution - The resolution of the texture.
     * @returns The width and height a new pooled texture would have, in physical pixels.
     */
    public getOptimalSize(frameWidth: number, frameHeight: number, resolution = 1): Size
    {
        return {
            width: this._fitWidth(toPixels(frameWidth, resolution)),
            height: this._fitHeight(toPixels(frameHeight, resolution)),
        };
    }

    private _fitWidth(pixelWidth: number): number
    {
        return this._fit(pixelWidth, this._screens.getFittingWidth(pixelWidth));
    }

    private _fitHeight(pixelHeight: number): number
    {
        return this._fit(pixelHeight, this._screens.getFittingHeight(pixelHeight));
    }

    private _fit(pixels: number, screen: number | undefined): number
    {
        // as before, only a power of two frame meets its texture's edge; any other keeps a clear texel past it
        const fitted = sizeClass(isPow2(pixels) ? pixels : pixels + 1);

        return screen !== undefined ? Math.min(screen, fitted) : fitted;
    }

    private _takeIdle(key: number): Texture | undefined
    {
        const texture = this._buckets.get(key)?.pop();

        if (texture) delete this._idleSince[texture.uid];

        return texture;
    }

    /**
     * Gets a pooled texture matching the dimensions and resolution of the given texture.
     *
     * This is a convenience wrapper around {@link TexturePoolClass#getOptimalTexture|getOptimalTexture}
     * that copies width, height, and resolution from an existing texture. Useful when a filter needs
     * a temporary texture the same size as its input (e.g., for multi-pass blur).
     * @param texture - The texture whose dimensions to match.
     * @param antialias - Whether to use antialias on the pooled texture. Defaults to `false`.
     * @returns A pooled texture with size-class or screen sized backing dimensions at the source resolution.
     */
    public getSameSizeTexture(texture: Texture, antialias = false)
    {
        const source = texture.source;

        return this.getOptimalTexture({
            width: texture.width,
            height: texture.height,
            resolution: source._resolution,
            antialias,
            format: getFilterTextureFormat(source.format),
        });
    }

    /**
     * Returns a texture to the pool so it can be reused by future
     * {@link TexturePoolClass#getOptimalTexture|getOptimalTexture}
     * or {@link TexturePoolClass#getSameSizeTexture|getSameSizeTexture} calls.
     *
     * If you gave the texture a style of your own after obtaining it (a different address mode, anisotropy
     * or similar), pass `resetStyle = true` so the pool puts its own style back. Otherwise your style stays
     * on the texture and the next consumer inherits it.
     * @param renderTexture - The texture to return to the pool.
     * @param resetStyle - When `true`, restores the style the pool created for this texture. Defaults to `false`.
     */
    public returnTexture(renderTexture: Texture, resetStyle = false): void
    {
        const uid = renderTexture.uid;
        const key = this._poolKey[uid];

        if (key === undefined)
        {
            // #if _DEBUG
            warn('TexturePool: returnTexture was passed a texture that did not come from this pool, ignoring it');
            // #endif

            return;
        }

        const poolStyle = this._poolStyle[uid];

        if (resetStyle && renderTexture.source.style !== poolStyle)
        {
            renderTexture.source.style = poolStyle;
        }

        const textures = this._buckets.get(key);

        if (!textures)
        {
            // the bucket this texture belongs to was pruned (its size no longer matches a screen),
            // so there is nothing to return it to - destroy it rather than resurrect a dead bucket
            delete this._poolKey[uid];
            delete this._poolStyle[uid];
            renderTexture.destroy(true);

            return;
        }

        this._idleSince[uid] = performance.now();
        textures.push(renderTexture);
    }

    /** Destroys textures idle for `idleTime` ms or longer (every idle one by default); call it between renders. */
    public trim(idleTime = 0): void
    {
        const now = performance.now();

        for (const textures of this._buckets.values())
        {
            // returns push in time order, so each bucket's longest idle textures lead it
            let expired = 0;

            while (expired < textures.length && now - this._idleSince[textures[expired].uid] >= idleTime) expired++;

            if (expired > 0) this._dropTextures(textures.splice(0, expired), true);
        }
    }

    /** Every texture waiting idle in the pool, for callers that account for what it holds. */
    public *idleTextures(): IterableIterator<Texture>
    {
        for (const textures of this._buckets.values()) yield* textures;
    }

    /**
     * Registers the screen size of a renderer with the pool, in physical pixels.
     *
     * While a screen is registered, a request that fits inside it on an axis is given that screen's size on
     * that axis when that is smaller than the request's size class, which keeps a full screen filter from
     * allocating a texture larger than the screen. Requests larger than every registered screen on an axis keep
     * their size class - the pool never rounds a request up to a screen it does not fit in.
     * @param rendererUid - The uid of the renderer, used to update or remove this screen later.
     * @param pixelWidth - The width of the screen in physical pixels.
     * @param pixelHeight - The height of the screen in physical pixels.
     */
    public setScreenSize(rendererUid: number, pixelWidth: number, pixelHeight: number): void
    {
        if (!this._screens.set(rendererUid, pixelWidth, pixelHeight)) return;

        this._pruneScreenTextures();
    }

    /**
     * Removes a screen previously registered with
     * {@link TexturePoolClass#setScreenSize|setScreenSize}, destroying any idle textures that were
     * only being kept for it.
     * @param rendererUid - The uid the screen was registered with.
     */
    public removeScreen(rendererUid: number): void
    {
        if (!this._screens.remove(rendererUid)) return;

        this._pruneScreenTextures();
    }

    /**
     * Destroys the idle textures in every bucket that has a dimension that is neither a size class nor that of
     * a live screen. Size class buckets are always kept, as any request can fall back to them.
     */
    private _pruneScreenTextures(): void
    {
        for (const [key, textures] of this._buckets)
        {
            const packed = key >>> 0;
            const width = packed >>> 17;
            const height = (packed >>> 2) & 0x7FFF;

            if ((sizeClass(width) === width || this._screens.hasWidth(width))
                && (sizeClass(height) === height || this._screens.hasHeight(height))) continue;

            this._dropTextures(textures, true);
            this._buckets.delete(key);
        }
    }

    /**
     * Forgets idle textures were ever handed out, so a later return is ignored, and optionally destroys them.
     * @param textures - The textures of one bucket.
     * @param destroy - Whether to destroy the textures as well.
     */
    private _dropTextures(textures: Texture[], destroy: boolean): void
    {
        for (let i = 0; i < textures.length; i++)
        {
            const texture = textures[i];

            delete this._poolKey[texture.uid];
            delete this._poolStyle[texture.uid];
            delete this._idleSince[texture.uid];

            if (destroy) texture.destroy(true);
        }
    }

    /**
     * Clears the pool.
     * @param destroyTextures - Destroy all stored textures.
     * @param format - When provided, clear only buckets of this format.
     */
    public clear(destroyTextures?: boolean, format?: TEXTURE_FORMATS): void
    {
        if (format !== undefined)
        {
            const id = formatIds[format];

            if (id === undefined) return;

            for (const [key, textures] of this._buckets)
            {
                if (Math.floor(Math.floor(key / flagsBit) / 4) !== id) continue;

                this._dropTextures(textures, destroyTextures !== false);
                this._buckets.delete(key);
            }

            return;
        }

        for (const textures of this._buckets.values())
        {
            this._dropTextures(textures, destroyTextures !== false);
        }

        this._buckets.clear();
    }
}

/**
 * The default texture pool instance.
 * @category rendering
 * @advanced
 */
export const TexturePool = new TexturePoolClass();
GlobalResourceRegistry.register(TexturePool);
