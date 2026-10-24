attribute vec2 aVertex;
attribute vec2 aUV;
attribute vec4 aColor;

attribute vec2 aPosition;
attribute float aRotation;

uniform mat3 uTranslationMatrix;
uniform float uRound;
uniform vec2 uResolution;
uniform vec4 uColor;

varying vec2 vUV;
varying vec4 vColor;

vec2 roundPixels(vec2 position, vec2 targetSize)
{       
    return (floor(((position * 0.5 + 0.5) * targetSize) + 0.5) / targetSize) * 2.0 - 1.0;
}

void main(void){
    float cosRotation = cos(aRotation);
    float sinRotation = sin(aRotation);
    float x = aVertex.x * cosRotation - aVertex.y * sinRotation;
    float y = aVertex.x * sinRotation + aVertex.y * cosRotation;

    // Rounding moves the anchor onto a whole pixel and the quad with it, so a turned quad keeps its shape.
    vec2 anchor = (uTranslationMatrix * vec3(aPosition, 1.0)).xy;

    if(uRound == 1.0)
    {
        anchor = roundPixels(anchor, uResolution);
    }

    gl_Position = vec4(anchor + (uTranslationMatrix * vec3(x, y, 0.0)).xy, 0.0, 1.0);

    vUV = aUV;
    vColor = vec4(aColor.rgb * aColor.a, aColor.a) * uColor;
}
