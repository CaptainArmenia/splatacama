import { MARKER_CONFIG } from '@/constants/cesiumConfig';
import { createClusterMarker, getMarkerImageId } from './cesiumMarkers';

const CLUSTER_ID_PREFIX = 'cluster:';

// A new cluster keeps its pins visible underneath it this long, while its own image loads, so nothing blinks
const CLUSTER_HANDOVER_MS = 150;

interface PinCluster {
  entity: any;
  memberIds: string[];
  imageKey: string;
  createdAt: number;
}

/**
 * Groups points that are closer than `maxDistance`. Greedy: in input order, each point not yet grouped takes every
 * other ungrouped point within `maxDistance` of it. Returns the groups of two or more, each as sorted ids.
 */
export function groupOverlapping(points: { id: string; x: number; y: number }[], maxDistance: number): string[][] {
  const grouped = new Set<string>();
  const groups: string[][] = [];
  points.forEach(point => {
    if (grouped.has(point.id)) return;
    const group = points.filter(other =>
      !grouped.has(other.id) && Math.hypot(point.x - other.x, point.y - other.y) < maxDistance
    );
    group.forEach(member => grouped.add(member.id));
    if (group.length > 1) groups.push(group.map(member => member.id).sort());
  });
  return groups;
}

/**
 * Screen offsets that fan `count` pins out in a ring, the first one to the left. `progress` runs from 0 (all at
 * the center) to 1 (fully out). The ring grows with the count so pins don't overlap.
 */
export function fanOutOffsets(count: number, progress: number): { x: number; y: number }[] {
  const radius = Math.max(MARKER_CONFIG.explodeRadius, count * 10);
  return Array.from({ length: count }, (_, i) => {
    const angle = Math.PI + (2 * Math.PI * i) / count;
    return { x: Math.cos(angle) * radius * progress, y: Math.sin(angle) * radius * progress };
  });
}

/**
 * Groups pins that overlap on screen into one cluster marker, and fans a cluster's pins out when it's clicked.
 *
 * This replaces Cesium's EntityCluster, which deletes and recreates every cluster marker each time the camera
 * moves. A recreated marker takes a frame or more to load its image, so clusters blinked out while zooming.
 * Here a cluster marker is an ordinary entity that lives as long as its group does. Grouping runs every frame,
 * which is cheap for the number of sites on this map.
 */
export function setupPinClusters(
  viewer: any,
  cesium: any,
  entityRefs: React.MutableRefObject<{ [id: string]: any }>,
  preventPinOcclusion: boolean
) {
  const clusters = new Map<string, PinCluster>();
  // Clusters that broke up last frame. Their markers stay one more frame: removing an entity takes effect
  // immediately, but the pins' size change only applies on the next frame's update, so removing both in
  // the same frame would draw neither.
  const retiring = new Map<string, PinCluster>();
  const hiddenPins = new Set<string>();
  let exploded: { memberIds: string[]; hub: any } | null = null;
  let animationFrame = 0;

  const pins = () => Object.values(entityRefs.current).filter((entity: any) => entity.billboard);

  const averagePosition = (memberIds: string[], time: any) => {
    const center = new cesium.Cartesian3();
    memberIds.forEach(id => cesium.Cartesian3.add(center, entityRefs.current[id].position.getValue(time), center));
    return cesium.Cartesian3.divideByScalar(center, memberIds.length, center);
  };

  // Pins under a cluster are shrunk to zero size rather than hidden: a hidden billboard is released, and showing
  // it again reloads its image, which leaves a gap of a frame or more. A zero-size one also can't be clicked.
  // Only assign on change, since every assignment creates a new Cesium property.
  const setPinShown = (entity: any, shown: boolean) => {
    if (hiddenPins.has(entity.id) !== shown) return;
    const size = shown ? MARKER_CONFIG.defaultSize : 0;
    entity.billboard.width = size;
    entity.billboard.height = size;
    if (shown) hiddenPins.delete(entity.id);
    else hiddenPins.add(entity.id);
    viewer.scene.requestRender();
  };

  const clusterImage = (memberIds: string[], time: any) => {
    const pinImages = memberIds
      .map(id => entityRefs.current[id]?.billboard?.image?.getValue(time))
      .filter(Boolean);
    const imageKey = `${memberIds.length}:${pinImages.map(getMarkerImageId).join(',')}`;
    return { imageKey, image: createClusterMarker(memberIds.length, pinImages, imageKey) };
  };

  const retire = (key: string) => {
    const cluster = clusters.get(key);
    if (!cluster) return;
    clusters.delete(key);
    retiring.set(key, cluster);
  };

  const update = () => {
    const time = viewer.clock.currentTime;
    const now = performance.now();
    const fannedOut = new Set(exploded?.memberIds ?? []);

    // Pins on screen, at their canvas position (undefined when behind the globe)
    const onScreen = pins()
      .filter((entity: any) => !fannedOut.has(entity.id))
      .map((entity: any) => ({
        id: entity.id as string,
        position: viewer.scene.cartesianToCanvasCoordinates(entity.position.getValue(time))
      }))
      .filter(item => item.position)
      .map(item => ({ id: item.id, x: item.position.x, y: item.position.y }));
    const groups = groupOverlapping(onScreen, MARKER_CONFIG.clusterDistance);

    // Create new clusters, refresh the image of existing ones if a member's photo changed
    const liveKeys = new Set<string>();
    groups.forEach(memberIds => {
      const key = memberIds.join('|');
      liveKeys.add(key);
      const { imageKey, image } = clusterImage(memberIds, time);
      if (retiring.has(key)) {
        // The group came back together before its marker was removed
        clusters.set(key, retiring.get(key) as PinCluster);
        retiring.delete(key);
      }
      const existing = clusters.get(key);

      if (!existing) {
        viewer.scene.requestRender();
        const entity = viewer.entities.add({
          id: CLUSTER_ID_PREFIX + key,
          position: averagePosition(memberIds, time),
          billboard: {
            image,
            width: MARKER_CONFIG.clusterSize,
            height: MARKER_CONFIG.clusterSize,
            verticalOrigin: cesium.VerticalOrigin.CENTER,
            horizontalOrigin: cesium.HorizontalOrigin.CENTER,
            // Same height rule as the pins, so the marker sits where they are
            heightReference: cesium.HeightReference.RELATIVE_TO_GROUND,
            disableDepthTestDistance: preventPinOcclusion ? Number.POSITIVE_INFINITY : undefined,
            eyeOffset: new cesium.Cartesian3(0, 0, -60)
          }
        });
        clusters.set(key, { entity, memberIds, imageKey, createdAt: now });
      } else if (existing.imageKey !== imageKey) {
        existing.entity.billboard.image = image;
        existing.imageKey = imageKey;
        viewer.scene.requestRender();
      }
    });

    // Remove markers retired last frame; their pins are showing by now. Retire clusters whose pins moved apart.
    if (retiring.size) viewer.scene.requestRender();
    retiring.forEach(cluster => viewer.entities.remove(cluster.entity));
    retiring.clear();
    clusters.forEach((cluster, key) => {
      if (!liveKeys.has(key)) retire(key);
    });

    // Hide pins that a cluster stands in for, once the cluster has had time to appear; show all others
    const standIns = new Set<string>();
    clusters.forEach(cluster => {
      if (now - cluster.createdAt > CLUSTER_HANDOVER_MS) cluster.memberIds.forEach(id => standIns.add(id));
    });
    pins().forEach((entity: any) => setPinShown(entity, !standIns.has(entity.id)));
  };

  // preUpdate runs every animation frame; preRender would only run on frames that are redrawn
  const removeUpdateListener = viewer.scene.preUpdate.addEventListener(update);

  const setOffsets = (memberIds: string[], progress: number) => {
    const offsets = fanOutOffsets(memberIds.length, progress);
    memberIds.forEach((id, i) => {
      entityRefs.current[id].billboard.pixelOffset = new cesium.Cartesian2(offsets[i].x, offsets[i].y);
    });
  };

  /** Folds fanned-out pins back; they rejoin clustering on the next frame. */
  const collapse = () => {
    if (!exploded) return;
    cancelAnimationFrame(animationFrame);
    exploded.memberIds.forEach(id => { entityRefs.current[id].billboard.pixelOffset = cesium.Cartesian2.ZERO; });
    viewer.entities.remove(exploded.hub);
    exploded = null;
    viewer.scene.requestRender();
  };

  /** Replaces a cluster with its pins, fanned out in a ring around their shared location. */
  const explode = (memberIds: string[]) => {
    collapse();
    retire(memberIds.join('|'));
    memberIds.forEach(id => setPinShown(entityRefs.current[id], true));

    // A small dot marks where the sites actually are, since their pins are drawn offset from it
    const hub = viewer.entities.add({
      position: averagePosition(memberIds, viewer.clock.currentTime),
      point: {
        pixelSize: 10,
        color: cesium.Color.WHITE,
        outlineColor: cesium.Color.fromCssColorString('#dd6b20'),
        outlineWidth: 3,
        heightReference: cesium.HeightReference.RELATIVE_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      }
    });
    exploded = { memberIds, hub };

    // Ease the pins out over a quarter second
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 250);
      setOffsets(memberIds, 1 - Math.pow(1 - t, 3));
      viewer.scene.requestRender();
      if (t < 1) animationFrame = requestAnimationFrame(step);
    };
    animationFrame = requestAnimationFrame(step);
  };

  /** The landmark ids a picked cluster marker stands for, or undefined if the entity isn't a cluster. */
  const getClusterMembers = (entity: any): string[] | undefined => {
    if (typeof entity?.id !== 'string' || !entity.id.startsWith(CLUSTER_ID_PREFIX)) return undefined;
    const key = entity.id.slice(CLUSTER_ID_PREFIX.length);
    return (clusters.get(key) ?? retiring.get(key))?.memberIds;
  };

  /** Stops grouping and animations; the entities themselves go away with the viewer. */
  const destroy = () => {
    removeUpdateListener();
    cancelAnimationFrame(animationFrame);
  };

  return { explode, collapse, getClusterMembers, destroy };
}
