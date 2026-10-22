import * as THREE from "/vendor/three/build/three.module.js";
import { OrbitControls } from "/vendor/three/examples/jsm/controls/OrbitControls.js";

const COLORS = {
  task: 0xa78bfa,
  action: 0x75e6dc,
  document: 0xf5cd78,
  file: 0x7899f5,
  code: 0x6fa8ff,
  configuration: 0xff8eaa
};
const SPAWN_DURATION_SECONDS = 1.45;
const SPAWN_HOLD_SECONDS = 0.12;

export function createWorldScene({ canvas, onActivate, onFocus }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x080a12, 0.014);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 220);
  camera.position.set(7, 6.5, 18);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.055;
  controls.enablePan = true;
  controls.screenSpacePanning = true;
  controls.minDistance = 1.25;
  controls.maxDistance = 110;
  controls.minPolarAngle = Math.PI * 0.2;
  controls.maxPolarAngle = Math.PI * 0.72;
  controls.target.set(-4, 0.3, 0);

  scene.add(new THREE.HemisphereLight(0xd8cbff, 0x090b16, 1.6));
  const key = new THREE.PointLight(0x75e6dc, 28, 30, 1.8);
  key.position.set(-5, 7, 7);
  scene.add(key);
  const fill = new THREE.PointLight(0xa78bfa, 32, 28, 1.8);
  fill.position.set(7, 2, 3);
  scene.add(fill);

  const environment = new THREE.Group();
  scene.add(environment);
  const grid = new THREE.GridHelper(120, 60, 0x5f548b, 0x25233a);
  grid.position.set(-35, -4.2, 0);
  grid.material.transparent = true;
  grid.material.opacity = 0.18;
  environment.add(grid);

  const stars = createStars();
  environment.add(stars);
  const core = createCore();
  core.group.position.x = 1.6;
  environment.add(core.group);

  let entityRoot = new THREE.Group();
  environment.add(entityRoot);
  let timeline = createTimeline(0);
  entityRoot.add(timeline);
  const entityNodes = new Map();
  let interactive = [core.hitTarget];
  let hovered = null;
  let entities = [];
  let frame = 0;
  let disposed = false;
  let pointerDown = null;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;

  function setEntities(nextEntities) {
    entities = Array.isArray(nextEntities) ? nextEntities : [];
    const retainedKeys = new Set();
    const keyOccurrences = new Map();
    let newNodeOrder = 0;

    entities.forEach((entity, index) => {
      const baseKey = entityKey(entity);
      const occurrence = keyOccurrences.get(baseKey) ?? 0;
      keyOccurrences.set(baseKey, occurrence + 1);
      const key = `${baseKey}:${occurrence}`;
      retainedKeys.add(key);

      const layout = entityLayout(index, entities.length);
      let node = entityNodes.get(key);
      if (!node) {
        const spawnStartedAt = clock.elapsedTime + SPAWN_HOLD_SECONDS + Math.min(newNodeOrder, 5) * 0.07;
        node = createEntityNode(entity, index, entities.length, reduceMotion, spawnStartedAt);
        newNodeOrder += 1;
        node.group.userData.entityKey = key;
        entityNodes.set(key, node);
        entityRoot.add(node.group);
      } else {
        updateEntityNode(node, entity);
        setNodeTarget(node.group, layout, index);
        node.group.userData.exiting = false;
        node.group.userData.motion.targetScale = 1;
      }
    });

    entityNodes.forEach((node, key) => {
      if (retainedKeys.has(key)) return;
      node.group.userData.exiting = true;
      node.group.userData.motion.spawning = false;
      node.group.userData.motion.targetScale = 0;
    });

    disposeTree(timeline);
    entityRoot.remove(timeline);
    timeline = createTimeline(entities.length);
    entityRoot.add(timeline);
    interactive = [core.hitTarget, ...[...entityNodes.entries()]
      .filter(([key]) => retainedKeys.has(key))
      .flatMap(([, node]) => node.hitTargets)];
  }

  function setActivity({ active = 0, waiting = 0 } = {}) {
    core.material.emissiveIntensity = active ? 2.4 : waiting ? 1.75 : 1.25;
    core.group.userData.activity = active ? 1.8 : waiting ? 1.25 : 1;
  }

  function updatePointer(event) {
    const bounds = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * 2 - 1;
    pointer.y = -((event.clientY - bounds.top) / Math.max(1, bounds.height)) * 2 + 1;
  }

  function pick(event) {
    updatePointer(event);
    raycaster.setFromCamera(pointer, camera);
    return raycaster.intersectObjects(interactive, false)[0]?.object ?? null;
  }

  canvas.addEventListener("pointerdown", (event) => { pointerDown = { x: event.clientX, y: event.clientY }; });
  canvas.addEventListener("pointermove", (event) => {
    const hit = pick(event);
    if (hit === hovered) return;
    if (hovered?.material?.emissiveIntensity !== undefined) hovered.material.emissiveIntensity = hovered.userData.baseGlow ?? 0.9;
    hovered = hit;
    if (hovered?.material?.emissiveIntensity !== undefined) hovered.material.emissiveIntensity = 2.8;
    canvas.style.cursor = hit ? "pointer" : "grab";
    onFocus?.(hit?.userData?.entity ?? null);
  });
  canvas.addEventListener("pointerleave", () => {
    if (hovered?.material?.emissiveIntensity !== undefined) hovered.material.emissiveIntensity = hovered.userData.baseGlow ?? 0.9;
    hovered = null;
    canvas.style.cursor = "grab";
    onFocus?.(null);
  });
  canvas.addEventListener("pointerup", (event) => {
    const moved = pointerDown ? Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) : 0;
    pointerDown = null;
    if (moved > 6) return;
    const entity = pick(event)?.userData?.entity;
    if (entity) onActivate?.(entity);
  });

  const resize = () => {
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    if (canvas.width !== Math.floor(width * renderer.getPixelRatio()) || canvas.height !== Math.floor(height * renderer.getPixelRatio())) {
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);

  const clock = new THREE.Clock();
  const animate = () => {
    if (disposed) return;
    frame = requestAnimationFrame(animate);
    resize();
    const delta = Math.min(clock.getDelta(), 1 / 20);
    const time = clock.elapsedTime;
    core.group.rotation.y = time * 0.22;
    core.shell.rotation.x = time * 0.16;
    core.shell.rotation.z = time * 0.11;
    core.group.position.y = Math.sin(time * 1.1) * 0.12;
    const pulse = core.group.userData.activity ?? 1;
    core.light.intensity = 20 + Math.sin(time * 2.1) * 4 * pulse;
    entityRoot.children.forEach((node) => {
      if (node.userData.timelinePulseObject) {
        const timelinePulse = node.userData.timelinePulseObject;
        const span = timelinePulse.userData.endX - timelinePulse.userData.startX;
        timelinePulse.position.x = timelinePulse.userData.startX + ((time * 1.35) % Math.max(1, span));
        return;
      }
      if (node.userData.timelinePulse) {
        const span = node.userData.endX - node.userData.startX;
        node.position.x = node.userData.startX + ((time * 1.35) % Math.max(1, span));
        return;
      }
      if (!node.userData.timelineNode) return;
      const motion = node.userData.motion;
      if (reduceMotion) {
        motion.x = motion.targetX;
        motion.angle = motion.targetAngle;
        motion.radius = motion.targetRadius;
        motion.scale = motion.targetScale;
      } else {
        springStep(motion, "x", "velocityX", "targetX", delta, 34, 11);
        springStep(motion, "angle", "velocityAngle", "targetAngle", delta, 30, 10.5);
        if (motion.spawning) {
          const progress = THREE.MathUtils.clamp((time - motion.spawnStartedAt) / SPAWN_DURATION_SECONDS, 0, 1);
          const stemProgress = smootherStep(progress);
          const contentProgress = smootherStep(THREE.MathUtils.clamp((progress - 0.16) / 0.84, 0, 1));
          motion.radius = motion.targetRadius * stemProgress;
          motion.scale = motion.targetScale * easeOutBack(contentProgress);
          if (progress >= 1) {
            motion.spawning = false;
            motion.radius = motion.targetRadius;
            motion.scale = motion.targetScale;
            motion.velocityRadius = 0;
            motion.velocityScale = 0;
          }
        } else {
          springStep(motion, "radius", "velocityRadius", "targetRadius", delta, 28, 10);
          springStep(motion, "scale", "velocityScale", "targetScale", delta, 42, 12);
        }
      }
      const angle = motion.angle + time * 0.09;
      const radius = Math.max(0, motion.radius);
      const y = Math.sin(angle) * radius;
      const z = Math.cos(angle) * radius;
      node.position.set(motion.x, y, z);
      const scale = THREE.MathUtils.clamp(motion.scale, 0, 1.04);
      node.userData.content.scale.setScalar(scale);
      node.userData.hitTarget.material.opacity = 0.9 * Math.min(1, scale * 1.7);
      if (motion.spawning) {
        node.userData.hitTarget.material.emissiveIntensity = 0.9
          + Math.sin(Math.PI * THREE.MathUtils.clamp(motion.scale, 0, 1)) * 1.35;
      }
      node.userData.label.material.opacity = Math.min(1, scale * 1.5);
      node.userData.stem.material.opacity = 0.18 * Math.min(1, radius / Math.max(0.001, motion.targetRadius));
      node.userData.hitTarget.rotation.x = time * 0.22 + node.userData.index * 0.3;
      node.userData.hitTarget.rotation.y = time * 0.16 + node.userData.index * 0.45;
      const stemPosition = node.userData.stem.geometry.attributes.position;
      stemPosition.setXYZ(0, 0, -y, -z);
      stemPosition.needsUpdate = true;

      if (node.userData.exiting && scale < 0.015) {
        entityRoot.remove(node);
        entityNodes.delete(node.userData.entityKey);
        disposeTree(node);
      }
    });
    stars.rotation.y = time * 0.008;
    controls.update();
    renderer.render(scene, camera);
  };
  animate();

  return {
    setEntities,
    setActivity,
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      disposeTree(environment);
      renderer.dispose();
    }
  };
}

function createCore() {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({
    color: 0x8b73d8, emissive: 0x6247b4, emissiveIntensity: 1.25,
    roughness: 0.24, metalness: 0.32, transparent: true, opacity: 0.94
  });
  const hitTarget = new THREE.Mesh(new THREE.IcosahedronGeometry(1.15, 3), material);
  hitTarget.userData.entity = { kind: "core", label: "Create a new intention" };
  hitTarget.userData.baseGlow = 1.25;
  group.add(hitTarget);
  const shell = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1.62, 1),
    new THREE.MeshBasicMaterial({ color: 0xd8cbff, wireframe: true, transparent: true, opacity: 0.2 })
  );
  group.add(shell);
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(2.05, 0.015, 8, 128),
    new THREE.MeshBasicMaterial({ color: 0x75e6dc, transparent: true, opacity: 0.32 })
  );
  ring.rotation.x = Math.PI * 0.58;
  group.add(ring);
  const light = new THREE.PointLight(0xa78bfa, 22, 13, 2);
  group.add(light);
  return { group, shell, hitTarget, material, light };
}

function createEntityNode(entity, index, total, reduceMotion = false, spawnStartedAt = 0) {
  const group = new THREE.Group();
  const layout = entityLayout(index, total);
  const initialRadius = reduceMotion ? layout.spiralRadius : 0;
  const initialScale = reduceMotion ? 1 : 0.001;
  const y = Math.sin(layout.spiralAngle) * initialRadius;
  const z = Math.cos(layout.spiralAngle) * initialRadius;
  group.position.set(layout.x, y, z);
  group.userData.timelineNode = true;
  group.userData.index = index;
  group.userData.motion = {
    x: layout.x, targetX: layout.x, velocityX: 0,
    angle: layout.spiralAngle, targetAngle: layout.spiralAngle, velocityAngle: 0,
    radius: initialRadius, targetRadius: layout.spiralRadius, velocityRadius: 0,
    scale: initialScale, targetScale: 1, velocityScale: 0,
    spawning: !reduceMotion, spawnStartedAt
  };

  const color = COLORS[entity.kind] ?? COLORS.file;
  const geometry = entity.kind === "action"
    ? new THREE.OctahedronGeometry(0.52, 1)
    : entity.kind === "task"
      ? new THREE.DodecahedronGeometry(0.62, 0)
      : new THREE.BoxGeometry(0.82, 0.82, 0.82, 2, 2, 2);
  const material = new THREE.MeshStandardMaterial({
    color, emissive: color, emissiveIntensity: 0.9, roughness: 0.32, metalness: 0.28,
    transparent: true, opacity: 0.9
  });
  const hitTarget = new THREE.Mesh(geometry, material);
  hitTarget.userData.entity = entity;
  hitTarget.userData.baseGlow = 0.9;
  const content = new THREE.Group();
  content.scale.setScalar(initialScale);
  content.add(hitTarget);
  const label = createLabel(entity);
  label.userData.entity = entity;
  content.add(label);
  group.add(content);

  const stem = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, -y, -z), new THREE.Vector3()]),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.18 })
  );
  group.add(stem);
  group.userData.stem = stem;
  group.userData.hitTarget = hitTarget;
  group.userData.label = label;
  group.userData.content = content;
  group.userData.visualSignature = entityVisualSignature(entity);
  return { group, hitTargets: [hitTarget, label] };
}

function entityLayout(index, total) {
  return {
    x: -(Math.max(0, total - 1 - index) * 1.75),
    spiralAngle: index * 2.399963229728653,
    spiralRadius: 2.45 + (index % 3) * 0.22
  };
}

function setNodeTarget(group, layout, index) {
  const motion = group.userData.motion;
  motion.targetX = layout.x;
  motion.targetAngle = motion.angle + shortestAngle(layout.spiralAngle - motion.angle);
  motion.targetRadius = layout.spiralRadius;
  group.userData.index = index;
}

function shortestAngle(value) {
  return Math.atan2(Math.sin(value), Math.cos(value));
}

function springStep(state, valueKey, velocityKey, targetKey, delta, stiffness, damping) {
  const displacement = state[targetKey] - state[valueKey];
  const acceleration = displacement * stiffness - state[velocityKey] * damping;
  state[velocityKey] += acceleration * delta;
  state[valueKey] += state[velocityKey] * delta;
  if (Math.abs(displacement) < 0.0001 && Math.abs(state[velocityKey]) < 0.0001) {
    state[valueKey] = state[targetKey];
    state[velocityKey] = 0;
  }
}

function smootherStep(value) {
  const progress = THREE.MathUtils.clamp(value, 0, 1);
  return progress * progress * progress * (progress * (progress * 6 - 15) + 10);
}

function easeOutBack(value) {
  if (value <= 0 || value >= 1) return value;
  const overshoot = 1.35;
  const shifted = value - 1;
  return 1 + (overshoot + 1) * shifted ** 3 + overshoot * shifted ** 2;
}

function entityKey(entity) {
  if (entity.kind === "task" && entity.taskId) return `task:${entity.taskId}`;
  if (entity.kind === "action") return `action:${entity.taskId || ""}:${entity.timestamp || ""}:${entity.label || ""}`;
  if (entity.filePath) return `file:${entity.filePath}`;
  return `${entity.kind || "item"}:${entity.label || ""}:${entity.timestamp || ""}`;
}

function entityVisualSignature(entity) {
  return `${entity.kind || "item"}\u0000${entity.label || ""}\u0000${entity.detail || ""}`;
}

function updateEntityNode(node, entity) {
  const { group, hitTargets } = node;
  group.userData.hitTarget.userData.entity = entity;
  group.userData.label.userData.entity = entity;
  if (group.userData.visualSignature === entityVisualSignature(entity)) return;

  const previousLabel = group.userData.label;
  const nextLabel = createLabel(entity);
  nextLabel.userData.entity = entity;
  group.userData.content.remove(previousLabel);
  disposeTree(previousLabel);
  group.userData.content.add(nextLabel);
  group.userData.label = nextLabel;
  group.userData.visualSignature = entityVisualSignature(entity);
  hitTargets[1] = nextLabel;
}

function createTimeline(total) {
  const group = new THREE.Group();
  const spacing = 1.75;
  const startX = -(Math.max(0, total - 1) * spacing) - 1.4;
  const endX = 2.25;
  const axis = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(startX, 0, 0), new THREE.Vector3(endX, 0, 0)]),
    new THREE.LineBasicMaterial({ color: 0x75e6dc, transparent: true, opacity: 0.34 })
  );
  group.add(axis);
  for (let index = 0; index < total; index += 1) {
    const x = -(Math.max(0, total - 1 - index) * spacing);
    const tick = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x, -0.16, 0), new THREE.Vector3(x, 0.16, 0)]),
      new THREE.LineBasicMaterial({ color: index === total - 1 ? 0xf5cd78 : 0x786fa1, transparent: true, opacity: index === total - 1 ? 0.9 : 0.35 })
    );
    group.add(tick);
  }
  const arrow = new THREE.Mesh(
    new THREE.ConeGeometry(0.18, 0.65, 16),
    new THREE.MeshBasicMaterial({ color: 0x75e6dc, transparent: true, opacity: 0.8 })
  );
  arrow.position.x = endX;
  arrow.rotation.z = -Math.PI / 2;
  group.add(arrow);
  const pulse = new THREE.Mesh(
    new THREE.SphereGeometry(0.12, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xffffff })
  );
  pulse.userData.timelinePulse = true;
  pulse.userData.startX = startX;
  pulse.userData.endX = endX;
  pulse.position.x = startX;
  group.add(pulse);
  group.userData.timelinePulseObject = pulse;
  return group;
}

function createLabel(entity) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 160;
  const context = canvas.getContext("2d");
  context.fillStyle = "rgba(10, 11, 21, .86)";
  roundRect(context, 4, 4, 504, 152, 24);
  context.fill();
  context.strokeStyle = "rgba(216, 203, 255, .26)";
  context.lineWidth = 2;
  context.stroke();
  context.fillStyle = "#9e9ab4";
  context.font = "600 21px Manrope, sans-serif";
  context.fillText(String(entity.kind || "item").toUpperCase(), 26, 42);
  context.fillStyle = "#f3f0ff";
  context.font = "600 28px Manrope, sans-serif";
  drawEllipsized(context, String(entity.label || "Untitled"), 26, 91, 460);
  context.fillStyle = "#9e9ab4";
  context.font = "500 19px Manrope, sans-serif";
  drawEllipsized(context, String(entity.detail || "Open"), 26, 126, 460);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: true }));
  sprite.position.set(0, -1.03, 0);
  sprite.scale.set(3.05, 0.95, 1);
  sprite.renderOrder = 4;
  return sprite;
}

function createStars() {
  const positions = new Float32Array(900 * 3);
  for (let index = 0; index < 900; index += 1) {
    const radius = 12 + Math.random() * 32;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[index * 3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[index * 3 + 1] = radius * Math.cos(phi);
    positions[index * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  return new THREE.Points(geometry, new THREE.PointsMaterial({ color: 0xbcaef3, size: 0.045, transparent: true, opacity: 0.52 }));
}

function roundRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}

function drawEllipsized(context, value, x, y, maxWidth) {
  let text = value;
  while (text.length > 1 && context.measureText(text).width > maxWidth) text = `${text.slice(0, -2)}…`;
  context.fillText(text, x, y);
}

function disposeTree(root) {
  root.traverse((object) => {
    object.geometry?.dispose?.();
    const materials = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
    materials.forEach((material) => {
      material.map?.dispose?.();
      material.dispose?.();
    });
  });
}
