import * as THREE from "/vendor/three/build/three.module.js";
import { OrbitControls } from "/vendor/three/examples/jsm/controls/OrbitControls.js";

const ROLE_COLORS = {
  semantic: 0x75e6dc,
  episodic: 0xa78bfa,
  procedural: 0xf5cd78,
  "known-answer": 0x8ee6a8,
  evidence: 0xff8eaa,
  working: 0x7899f5
};

export function createMemoryScene({ canvas, onActivate, onFocus }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x080a12, 0.018);
  const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 180);
  camera.position.set(0, 6, 24);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.enablePan = true;
  controls.screenSpacePanning = true;
  controls.minDistance = 5;
  controls.maxDistance = 70;
  controls.target.set(0, 0, 0);

  scene.add(new THREE.HemisphereLight(0xd8cbff, 0x080a12, 1.3));
  const cyanLight = new THREE.PointLight(0x75e6dc, 34, 48, 1.7);
  cyanLight.position.set(-10, 9, 10);
  scene.add(cyanLight);
  const violetLight = new THREE.PointLight(0xa78bfa, 30, 42, 1.8);
  violetLight.position.set(11, -3, 7);
  scene.add(violetLight);

  const stars = createMemoryStars();
  scene.add(stars);
  let graphRoot = new THREE.Group();
  scene.add(graphRoot);
  let nodeEntries = new Map();
  let interactive = [];
  let hovered = null;
  let selectedId = "";
  let pointerDown = null;
  let disposed = false;
  let frame = 0;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const clock = new THREE.Clock();

  function setGraph({ nodes = [], edges = [], selectedId: nextSelectedId = "" } = {}) {
    disposeTree(graphRoot);
    scene.remove(graphRoot);
    graphRoot = new THREE.Group();
    scene.add(graphRoot);
    nodeEntries = new Map();
    interactive = [];
    selectedId = nextSelectedId;

    const positions = constellationLayout(nodes);
    const positionById = new Map();
    nodes.forEach((memory, index) => {
      const position = positions[index];
      positionById.set(memory.id, position);
      const entry = createMemoryNode(memory, position, index);
      nodeEntries.set(memory.id, entry);
      interactive.push(entry.hitTarget);
      graphRoot.add(entry.group);
    });

    const linePositions = [];
    const lineColors = [];
    edges.forEach((edge) => {
      const source = positionById.get(edge.source);
      const target = positionById.get(edge.target);
      if (!source || !target) return;
      linePositions.push(source.x, source.y, source.z, target.x, target.y, target.z);
      const color = edgeColor(edge.kind).multiplyScalar(0.45 + Math.min(1, Math.max(0, Number(edge.strength || 0))) * 0.55);
      lineColors.push(color.r, color.g, color.b, color.r, color.g, color.b);
    });
    if (linePositions.length) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(linePositions, 3));
      geometry.setAttribute("color", new THREE.Float32BufferAttribute(lineColors, 3));
      const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, opacity: 0.38, depthWrite: false, blending: THREE.AdditiveBlending
      }));
      lines.userData.associationLines = true;
      graphRoot.add(lines);
    }

    createClusterHalos(nodes, positions).forEach((halo) => graphRoot.add(halo));
    select(selectedId);
  }

  function select(id) {
    selectedId = id || "";
    nodeEntries.forEach((entry, nodeId) => {
      const selected = nodeId === selectedId;
      entry.material.emissiveIntensity = selected ? 3.4 : entry.memory.inWorkingMemory ? 2.1 : entry.baseGlow;
      entry.group.scale.setScalar(selected ? entry.baseScale * 1.3 : entry.baseScale);
      entry.shell.material.opacity = selected ? 0.5 : 0.18;
    });
  }

  function createMemoryNode(memory, position, index) {
    const role = primaryRole(memory.roles);
    const color = ROLE_COLORS[role] ?? ROLE_COLORS.working;
    const importance = Math.min(1, Math.max(0, Number(memory.importance || 0)));
    const baseScale = 0.72 + importance * 0.42;
    const geometry = nodeGeometry(role);
    const material = new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: memory.inWorkingMemory ? 2.1 : 1.15,
      roughness: 0.28, metalness: 0.22, transparent: true,
      opacity: memory.status === "dormant" ? 0.58 : 0.92
    });
    const hitTarget = new THREE.Mesh(geometry, material);
    hitTarget.userData.memory = memory;
    hitTarget.userData.baseGlow = material.emissiveIntensity;
    const shell = new THREE.Mesh(geometry.clone(), new THREE.MeshBasicMaterial({
      color, wireframe: true, transparent: true, opacity: 0.18, depthWrite: false
    }));
    shell.scale.setScalar(1.28);
    const group = new THREE.Group();
    group.position.copy(position);
    group.scale.setScalar(baseScale);
    group.userData.index = index;
    group.userData.phase = (hashText(memory.id) % 628) / 100;
    group.add(hitTarget, shell);
    return { group, hitTarget, shell, material, memory, baseGlow: material.emissiveIntensity, baseScale };
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
    if (hovered && hovered.userData.memory?.id !== selectedId) hovered.material.emissiveIntensity = hovered.userData.baseGlow;
    hovered = hit;
    if (hovered) hovered.material.emissiveIntensity = 3;
    canvas.style.cursor = hit ? "pointer" : "grab";
    onFocus?.(hit?.userData?.memory ?? null);
  });
  canvas.addEventListener("pointerleave", () => {
    if (hovered && hovered.userData.memory?.id !== selectedId) hovered.material.emissiveIntensity = hovered.userData.baseGlow;
    hovered = null;
    canvas.style.cursor = "grab";
    onFocus?.(null);
  });
  canvas.addEventListener("pointerup", (event) => {
    const moved = pointerDown ? Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) : 0;
    pointerDown = null;
    if (moved > 6) return;
    const memory = pick(event)?.userData?.memory;
    if (memory) onActivate?.(memory);
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

  const animate = () => {
    if (disposed) return;
    frame = requestAnimationFrame(animate);
    resize();
    const time = clock.getElapsedTime();
    graphRoot.rotation.y = Math.sin(time * 0.08) * 0.08;
    nodeEntries.forEach((entry) => {
      const pulse = 1 + Math.sin(time * 1.3 + entry.group.userData.phase) * 0.035;
      const selectedScale = entry.memory.id === selectedId ? 1.3 : 1;
      entry.group.scale.setScalar(entry.baseScale * selectedScale * pulse);
      entry.hitTarget.rotation.x = time * 0.12 + entry.group.userData.index * 0.17;
      entry.hitTarget.rotation.y = time * 0.16 + entry.group.userData.index * 0.23;
      entry.shell.rotation.x = -time * 0.08;
      entry.shell.rotation.z = time * 0.1;
    });
    stars.rotation.y = time * 0.006;
    stars.rotation.x = Math.sin(time * 0.025) * 0.04;
    controls.update();
    renderer.render(scene, camera);
  };
  animate();

  return {
    setGraph,
    select,
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      disposeTree(graphRoot);
      stars.geometry.dispose();
      stars.material.dispose();
      renderer.dispose();
    }
  };
}

function constellationLayout(nodes) {
  const groups = new Map();
  nodes.forEach((node, index) => {
    const key = node.workerId || "global";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ node, index });
  });
  const entries = [...groups.entries()].sort(([left], [right]) => left === "global" ? -1 : right === "global" ? 1 : left.localeCompare(right));
  const positions = Array(nodes.length);
  entries.forEach(([key, members], groupIndex) => {
    const lone = entries.length === 1;
    const groupAngle = Math.PI * 2 * groupIndex / Math.max(1, entries.length);
    const center = lone
      ? new THREE.Vector3()
      : new THREE.Vector3(Math.cos(groupAngle) * 8.5, ((groupIndex % 3) - 1) * 2.4, Math.sin(groupAngle) * 8.5);
    const rotation = (hashText(key) % 628) / 100;
    members.forEach(({ index }, memberIndex) => {
      if (members.length === 1) {
        positions[index] = center.clone();
        return;
      }
      const radius = Math.min(4.8, 1.5 + Math.sqrt(memberIndex + 1) * 0.72);
      const y = 1 - 2 * ((memberIndex + 0.5) / members.length);
      const ring = Math.sqrt(Math.max(0, 1 - y * y));
      const angle = rotation + memberIndex * 2.399963;
      positions[index] = center.clone().add(new THREE.Vector3(Math.cos(angle) * ring * radius, y * radius, Math.sin(angle) * ring * radius));
    });
  });
  return positions;
}

function createClusterHalos(nodes, positions) {
  const centers = new Map();
  nodes.forEach((node, index) => {
    const key = node.workerId || "global";
    const entry = centers.get(key) || { position: new THREE.Vector3(), count: 0, global: key === "global" };
    entry.position.add(positions[index]);
    entry.count += 1;
    centers.set(key, entry);
  });
  return [...centers.values()].map((entry) => {
    entry.position.multiplyScalar(1 / entry.count);
    const radius = Math.min(5.8, 2.2 + Math.sqrt(entry.count) * 0.55);
    const material = new THREE.MeshBasicMaterial({
      color: entry.global ? ROLE_COLORS.semantic : ROLE_COLORS.episodic,
      transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending
    });
    const halo = new THREE.Mesh(new THREE.RingGeometry(radius * 0.96, radius, 64), material);
    halo.position.copy(entry.position);
    halo.rotation.x = Math.PI / 2;
    return halo;
  });
}

function createMemoryStars() {
  const positions = [];
  for (let index = 0; index < 750; index += 1) {
    const radius = 25 + (index % 17) * 2.3;
    const theta = index * 2.399963;
    const phi = Math.acos(1 - 2 * ((index + 0.5) / 750));
    positions.push(radius * Math.sin(phi) * Math.cos(theta), radius * Math.cos(phi), radius * Math.sin(phi) * Math.sin(theta));
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  return new THREE.Points(geometry, new THREE.PointsMaterial({ color: 0x8275ad, size: 0.055, transparent: true, opacity: 0.52, depthWrite: false }));
}

function nodeGeometry(role) {
  if (role === "procedural") return new THREE.TorusKnotGeometry(0.42, 0.13, 48, 8);
  if (role === "episodic") return new THREE.OctahedronGeometry(0.58, 1);
  if (role === "evidence") return new THREE.TetrahedronGeometry(0.62, 1);
  if (role === "known-answer") return new THREE.DodecahedronGeometry(0.56, 0);
  if (role === "working") return new THREE.BoxGeometry(0.82, 0.82, 0.82, 2, 2, 2);
  return new THREE.IcosahedronGeometry(0.58, 2);
}

function primaryRole(roles = []) {
  return ["semantic", "episodic", "procedural", "known-answer", "evidence", "working"].find((role) => roles.includes(role)) || "working";
}

function edgeColor(kind) {
  if (kind === "supports") return new THREE.Color(0x75e6dc);
  if (kind === "contradicts" || kind === "inhibitory") return new THREE.Color(0xff8eaa);
  if (kind === "causal" || kind === "derived-from") return new THREE.Color(0xf5cd78);
  return new THREE.Color(0xa78bfa);
}

function hashText(value) {
  return [...String(value)].reduce((hash, character) => ((hash * 31) + character.charCodeAt(0)) >>> 0, 7);
}

function disposeTree(root) {
  root.traverse((object) => {
    object.geometry?.dispose?.();
    if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose?.());
    else object.material?.dispose?.();
  });
}
