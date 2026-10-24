import '~/rendering/init';
import { Graphics } from '../../../graphics/shared/Graphics';
import { Container } from '../../Container';
import { checkChildrenDidChange } from '../checkChildrenDidChange';
import { Rectangle } from '~/maths';

function recheck(container: Container, previousData: { data: number[], index: number, didChange: boolean }): boolean
{
    previousData.index = 0;
    previousData.didChange = false;

    return checkChildrenDidChange(container, previousData);
}

describe('checkChildrenDidChange', () =>
{
    it('should correctly manage ids', async () =>
    {
        const container = new Container();

        const child = new Container();

        container.addChild(child);

        const previousData = {
            data: [] as number[],
            index: 0,
            didChange: false,
        };

        checkChildrenDidChange(container, previousData);

        let childChange = ((child._didViewChangeTick & 0xffff) << 16) | (child._didContainerChangeTick & 0xffff);

        expect(previousData).toEqual({
            data: [child.uid, childChange],
            index: 2,
            didChange: true,
        });

        previousData.index = 0;
        previousData.didChange = false;

        checkChildrenDidChange(container, previousData);

        expect(previousData).toEqual({
            data: [child.uid, childChange],
            index: 2,
            didChange: false,
        });

        child.x += 1;

        previousData.index = 0;
        previousData.didChange = false;

        checkChildrenDidChange(container, previousData);

        childChange = ((child._didViewChangeTick & 0xffff) << 16) | (child._didContainerChangeTick & 0xffff);

        expect(previousData).toEqual({
            data: [child.uid, childChange],
            index: 2,
            didChange: true,
        });
    });

    it('should record a bounds area by value in place of the children below it', async () =>
    {
        const container = new Container();
        const area = new Container({ boundsArea: new Rectangle(0, 0, 10, 10) });
        const child = new Container();

        container.addChild(area);
        area.addChild(child);

        const previousData = { data: [] as number[], index: 0, didChange: false };

        expect(recheck(container, previousData)).toBe(true);
        expect(previousData.index).toEqual(6);
        expect(previousData.data.slice(2)).toEqual([0, 0, 10, 10]);

        child.x += 1;
        child.addChild(new Container());

        expect(recheck(container, previousData)).toBe(false);

        area.boundsArea.height = 20;

        expect(recheck(container, previousData)).toBe(true);
        expect(recheck(container, previousData)).toBe(false);

        area.boundsArea = null;

        expect(recheck(container, previousData)).toBe(true);
        expect(previousData.index).toEqual(6);
    });

    it('should walk below a bounds area whose own mask is among its children', async () =>
    {
        const container = new Container();
        const area = new Container({ boundsArea: new Rectangle(0, 0, 10, 10) });
        const holder = new Container();
        const mask = new Graphics().rect(0, 0, 5, 5).fill(0xffffff);

        container.addChild(area);
        area.addChild(holder);
        holder.addChild(mask);
        area.mask = mask;

        const previousData = { data: [] as number[], index: 0, didChange: false };

        recheck(container, previousData);
        mask.x += 1;

        expect(recheck(container, previousData)).toBe(true);

        area.mask = null;
        recheck(container, previousData);
        mask.x += 1;

        expect(recheck(container, previousData)).toBe(false);
    });
});
