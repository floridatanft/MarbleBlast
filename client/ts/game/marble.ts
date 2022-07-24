import { ResourceManager } from "../resources";
import { isPressed, gamepadAxes, normalizedJoystickHandlePosition, getPressedFlag } from "../input";
import { Shape } from "./shape";
import { Util } from "../util";
import { AudioManager, AudioSource } from "../audio";
import { StorageManager } from "../storage";
import { MisParser, MissionElementSimGroup, MissionElementTrigger, MissionElementType } from "../../../shared/mis_parser";
import { ParticleEmitter, ParticleEmitterOptions } from "../rendering/particles";
import { G } from "../global";
import { Group } from "../rendering/group";
import { Geometry } from "../rendering/geometry";
import { Material } from "../rendering/material";
import { Texture } from "../rendering/texture";
import { Mesh } from "../rendering/mesh";
import { CubeTexture } from "../rendering/cube_texture";
import { CubeCamera } from "../rendering/cube_camera";
import { mainRenderer } from "../ui/misc";
import { RigidBody, RigidBodyType } from "../physics/rigid_body";
import { BallCollisionShape, CollisionShape } from "../physics/collision_shape";
import { Collision } from "../physics/collision";
import { Vector3 } from "../math/vector3";
import { Quaternion } from "../math/quaternion";
import { Euler } from "../math/euler";
import { BlendingType } from "../rendering/renderer";
import { Entity } from "./entity";
import { Game } from "./game";
import { GAME_UPDATE_RATE } from "../../../shared/constants";
import { GO_TIME, READY_TIME, SET_TIME } from "./game_state";
import { Vector2 } from "../math/vector2";
import { MultiplayerGame } from "./multiplayer_game";
import { EntityState, entityStateFormat } from "../../../shared/game_server_format";
import { Player } from "./player";
import { FixedFormatBinarySerializer } from "../../../shared/fixed_format_binary_serializer";
import { TeleportTrigger } from "./triggers/teleport_trigger";
import { DefaultMap } from "../../../shared/default_map";
import { CheckpointState } from "./checkpoint_state";
import { MisUtils } from "../parsing/mis_utils";
import { Gem } from "./shapes/gem";
import { PowerUp } from "./shapes/power_up";
import { StartPad } from "./shapes/start_pad";
import { GameMode } from "./game_mode";

const DEFAULT_RADIUS = 0.2;
const ULTRA_RADIUS = 0.3;
const MEGA_MARBLE_RADIUS = 0.6666;
export const MARBLE_ROLL_FORCE = 40 || 40;
const TELEPORT_FADE_DURATION = 0.5;
const BLAST_CHARGE_TIME = 25000;
export const DEFAULT_PITCH = 0.45;
export const DEFAULT_YAW = Math.PI / 2;

export const bounceParticleOptions: ParticleEmitterOptions = {
	ejectionPeriod: 1,
	ambientVelocity: new Vector3(0, 0, 0),
	ejectionVelocity: 2.6,
	velocityVariance: 0.25 * 0.5,
	emitterLifetime: 3, // Spawn 4 particles
	inheritedVelFactor: 0,
	particleOptions: {
		texture: 'particles/star.png',
		blending: BlendingType.Normal,
		spinSpeed: 90,
		spinRandomMin: -90,
		spinRandomMax: 90,
		lifetime: 500,
		lifetimeVariance: 100,
		dragCoefficient: 0.5,
		acceleration: -2,
		colors: [{r: 0.9, g: 0, b: 0, a: 1}, {r: 0.9, g: 0.9, b: 0, a: 1}, {r: 0.9, g: 0.9, b: 0, a: 0}],
		sizes: [0.25, 0.25, 0.25],
		times: [0, 0.75, 1]
	}
};

const blastParticleOptions: ParticleEmitterOptions = {
	ejectionPeriod: 0.9,
	ambientVelocity: new Vector3(0, 0, -0.3),
	ejectionVelocity: 3,
	velocityVariance: 0.4,
	emitterLifetime: 300,
	inheritedVelFactor: 0.25,
	particleOptions: {
		texture: 'particles/smoke.png',
		blending: BlendingType.Additive,
		spinSpeed: 20,
		spinRandomMin: -90,
		spinRandomMax: 90,
		lifetime: 600,
		lifetimeVariance: 250,
		dragCoefficient: 0.2,
		acceleration: -0.1,
		colors: [{r: 25/255, g: 244/255, b: 255/255, a: 0.2}, {r: 25/255, g: 244/255, b: 255/255, a: 1}, {r: 25/255, g: 244/255, b: 255/255, a: 1}, {r: 25/255, g: 244/255, b: 255/255, a: 0}],
		sizes: [0.1, 0.1, 0.1],
		times: [0, 0.2, 0.75, 1]
	}
};
const blastMaxParticleOptions = ParticleEmitter.cloneOptions(blastParticleOptions);
blastMaxParticleOptions.ejectionVelocity = 4;
blastMaxParticleOptions.ejectionPeriod = 0.7;
blastMaxParticleOptions.particleOptions.dragCoefficient = 0.3;
blastMaxParticleOptions.particleOptions.colors = blastMaxParticleOptions.particleOptions.colors.map(x => { x.r = 255/255; x.g = 159/255; x.b = 25/255; return x; });

type MarbleState = EntityState & { entityType: 'marble' };

interface InternalMarbleState {
	collisions: Collision[],
	inContactCcd: Set<CollisionShape>,
	lastContactNormal: Vector3,
	slidingTimeout: number,
	oldOrientationQuat: Quaternion,
	orientationQuat: Quaternion,
	orientationChangeTime: number,
	endPadColliderTimeout: number
}

export interface MarbleControlState {
	movement: Vector2,
	yaw: number,
	pitch: number,
	jumping: boolean,
	using: boolean,
	blasting: boolean
}

export class Marble extends Entity {
	restartable = true;

	group: Group;
	innerGroup: Group;
	sphere: Mesh;
	ballShape: Shape;
	/** The predicted position of the marble in the next tick. */
	predictedPosition = new Vector3();
	/** The predicted orientation of the marble in the next tick. */
	predictedOrientation = new Quaternion();
	addedToGame = false;

	body: RigidBody;
	/** Main collision shape of the marble. */
	shape: BallCollisionShape;
	/** First auxiliary collision shape of the marble; being twice as big as the normal shape, it's responsible for colliding with shapes such as gems and power-ups. */
	largeAuxShape: BallCollisionShape;
	/** Second auxiliary collision shape of the marble; is responsible for colliding with triggers. */
	smallAuxShape: BallCollisionShape;

	/** The radius of the marble. */
	radius: number = null;
	/** The default jump impulse of the marble. */
	jumpImpulse = 0 || 7.3; // For now, seems to fit more than the "actual" 7.5.
	/** The default restitution of the marble. */
	bounceRestitution = 0.5;

	controllingPlayer: Player;
	currentControlState = Marble.getPassiveControlState();

	get speedFac() {
		return DEFAULT_RADIUS / this.radius;
	}

	/** Forcefield around the player shown during super bounce and shock absorber usage. */
	forcefield: Shape;
	/** Helicopter shown above the marble shown during gyrocopter usage. */
	helicopter: Shape;
	superBounceEnableFrame = -Infinity;
	shockAbsorberEnableFrame = -Infinity;
	helicopterEnableFrame = -Infinity;
	megaMarbleEnableFrame = -Infinity;
	helicopterSound: AudioSource = null;
	shockAbsorberSound: AudioSource = null;
	superBounceSound: AudioSource = null;
	teleportEnableTime: number = null;
	teleportDisableTime: number = null;

	beforeVel = new Vector3();
	beforeAngVel = new Vector3();
	/** Necessary for super speed. */
	lastContactNormal = new Vector3();
	slidingTimeout = 0;

	rollingSound: AudioSource;
	rollingMegaMarbleSound: AudioSource;
	slidingSound: AudioSource;

	cubeMap: CubeTexture;
	cubeCamera: CubeCamera;

	endPadColliderTimeout = 0;
	inFinishState = false;
	finishCameraAnimationStart: number = null;
	finishYaw: number;
	finishPitch: number;

	outOfBoundsFrame: number = null;
	outOfBoundsCameraPosition: Vector3 = null;
	respawnFrame = 0;

	oldUp = new Vector3(0, 0, 1);
	currentUp = new Vector3(0, 0, 1);
	/** The last time the orientation was changed (by a gravity modifier) */
	orientationChangeTime = -Infinity;
	/** The old camera orientation quat */
	oldOrientationQuat = new Quaternion();
	/** The new target camera orientation quat */
	orientationQuat = new Quaternion();

	heldPowerUp: PowerUp = null;
	blastAmount = 0;

	checkpointState: CheckpointState;

	reconciliationPosition = new Vector3();

	interpolatedPosition = new Vector3();
	interpolatedOrientation = new Quaternion();
	interpolationRemaining = 0;
	interpolationStrength = 1;

	teleportStates: {
		trigger: TeleportTrigger,
		entryFrame: number,
		exitFrame: number
	}[] = [];
	teleportSounds = new DefaultMap<TeleportTrigger, AudioSource[]>(() => []);

	spawnPosition = new Vector3(0, 0, 300);
	spawnRotation = new Euler();
	lastComputedSpawnElementId: number = null;

	constructor(game: Game, id: number, checkpointStateId: number) {
		super(game);

		this.id = id;
		this.checkpointState = new CheckpointState(game, checkpointStateId, this);
	}

	async init() {
		this.group = new Group(true);
		this.innerGroup = new Group();
		this.group.add(this.innerGroup);

		let mission = this.game.mission;

		if (mission.misFile.marbleAttributes["jumpImpulse"] !== undefined)
			this.jumpImpulse = MisParser.parseNumber(mission.misFile.marbleAttributes["jumpImpulse"]);
		if (mission.misFile.marbleAttributes["bounceRestitution"] !== undefined)
			this.bounceRestitution = MisParser.parseNumber(mission.misFile.marbleAttributes["bounceRestitution"]);

		// Get the correct texture
		let marbleTexture: Texture;
		let customTextureBlob = await StorageManager.databaseGet('keyvalue', 'marbleTexture');
		if (customTextureBlob) {
			try {
				let url = ResourceManager.getUrlToBlob(customTextureBlob);
				marbleTexture = await ResourceManager.getTexture(url, '');
			} catch (e) {
				console.error("Failed to load custom marble texture:", e);
			}
		} else {
			marbleTexture = await ResourceManager.getTexture("shapes/balls/base.marble.png");
		}

		let has2To1Texture = marbleTexture.image.width === marbleTexture.image.height * 2;

		if (this.isReflective()) {
			this.cubeMap = new CubeTexture(mainRenderer, 128);
			this.cubeCamera = new CubeCamera(0.025, this.game.renderer.camera.far);
		}

		const addMarbleReflectivity = (m: Material) => {
			m.envMap = this.cubeMap;
			m.envMapZUp = false;
			m.reflectivity = 0.7;
			m.useFresnel = true;
			m.useAccurateReflectionRay = true;
		};

		// Create the 3D object
		if (has2To1Texture || (mission.modification === 'ultra' && !customTextureBlob)) {
			let ballShape = new Shape();
			ballShape.shareMaterials = false;
			ballShape.dtsPath = 'shapes/balls/pack1/pack1marble.dts';
			ballShape.castShadows = true;
			ballShape.materialPostprocessor = m => {
				m.normalizeNormals = true; // We do this so that the marble doesn't get darker the larger it gets
				m.flipY = true;

				if (this.isReflective()) addMarbleReflectivity(m);
			};

			if (customTextureBlob) ballShape.matNamesOverride['base.marble'] = marbleTexture;
			await ballShape.init(this.game);
			this.innerGroup.add(ballShape.group);
			this.ballShape = ballShape;
		}

		let geometry = Geometry.createSphereGeometry(1, 32, 16);
		let sphereMaterial = new Material();
		sphereMaterial.diffuseMap = marbleTexture;
		sphereMaterial.normalizeNormals = true;
		sphereMaterial.flipY = true;

		if (this.isReflective()) addMarbleReflectivity(sphereMaterial);

		// Create the sphere's mesh
		let sphere = new Mesh(geometry, [sphereMaterial]);
		sphere.castShadows = true;
		this.sphere = sphere;
		this.innerGroup.add(sphere);

		// Create the physics stuff
		this.body = new RigidBody();
		this.body.userData = this;
		this.body.evaluationOrder = this.id + 1000000; // Make sure this body's handlers are called after all the other ones (interiors, shapes, etc)
		let colShape = new BallCollisionShape(0); // We'll update the radius later
		colShape.restitution = this.bounceRestitution;
		this.shape = colShape;
		this.body.addCollisionShape(colShape);

		let largeAuxShape = new BallCollisionShape(0);
		largeAuxShape.collisionDetectionMask = 0b10;
		largeAuxShape.collisionResponseMask = 0;
		this.body.addCollisionShape(largeAuxShape);

		let smallAuxShape = new BallCollisionShape(0);
		smallAuxShape.collisionDetectionMask = 0b100;
		smallAuxShape.collisionResponseMask = 0;
		this.body.addCollisionShape(smallAuxShape);

		colShape.broadphaseShape = largeAuxShape;
		smallAuxShape.broadphaseShape = largeAuxShape;

		this.largeAuxShape = largeAuxShape;
		this.smallAuxShape = smallAuxShape;

		this.body.onBeforeIntegrate = this.onBeforeIntegrate.bind(this);
		this.body.onAfterIntegrate = this.onAfterIntegrate.bind(this);
		this.body.onBeforeCollisionResponse = this.onBeforeCollisionResponse.bind(this);
		this.body.onAfterCollisionResponse = this.onAfterCollisionResponse.bind(this);

		// Set the marble's default orientation to be close to actual MBP
		this.body.orientation.setFromEuler(new Euler(Math.PI/2, Math.PI * 7/6, 0));

		this.forcefield = new Shape();
		this.forcefield.dtsPath = "shapes/images/glow_bounce.dts";
		this.forcefield.shareId = this.id;
		await this.forcefield.init(this.game);
		this.forcefield.setOpacity(0);
		this.forcefield.showSequences = false; // Hide the weird default animation it does
		this.innerGroup.add(this.forcefield.group);

		this.helicopter = new Shape();
		// Easter egg: Due to an iconic bug where the helicopter would instead look like a glow bounce, this can now happen 0.1% of the time.
		this.helicopter.dtsPath = (Math.random() < 1 / 1000)? "shapes/images/glow_bounce.dts" : "shapes/images/helicopter.dts";
		this.helicopter.castShadows = true;
		this.helicopter.shareId = this.id;
		await this.helicopter.init(this.game);
		this.helicopter.setOpacity(0);
		this.group.add(this.helicopter.group);

		// Load the necessary rolling sounds
		let toLoad = ["jump.wav", "bouncehard1.wav", "bouncehard2.wav", "bouncehard3.wav", "bouncehard4.wav", "rolling_hard.wav", "sliding.wav"];
		if (mission.hasBlast) toLoad.push("blast.wav");
		await AudioManager.loadBuffers(toLoad);

		this.rollingSound = AudioManager.createAudioSource('rolling_hard.wav', undefined, this.body.position);
		this.rollingSound.play();
		this.rollingSound.gain.gain.value = 0;
		this.rollingSound.setLoop(true);

		// Check if we need to prep a Mega Marble sound
		if (mission.allElements.some(x => x._type === MissionElementType.Item && x.datablock?.toLowerCase() === 'megamarbleitem')) {
			this.rollingMegaMarbleSound = AudioManager.createAudioSource('mega_roll.wav', undefined, this.body.position);
			this.rollingMegaMarbleSound.gain.gain.value = 0;
			this.rollingMegaMarbleSound.setLoop(true);
		}

		this.slidingSound = AudioManager.createAudioSource('sliding.wav', undefined, this.body.position);
		this.slidingSound.play();
		this.slidingSound.gain.gain.value = 0;
		this.slidingSound.setLoop(true);

		await Promise.all([this.rollingSound.promise, this.slidingSound.promise, this.rollingMegaMarbleSound?.promise]);
	}

	/** Returns true iff the marble should use special reflective shaders. */
	isReflective() {
		return (StorageManager.data.settings.marbleReflectivity === 2 || (StorageManager.data.settings.marbleReflectivity === 0 && this.game.mission.modification === 'ultra')) && !Util.isIOS();
		// On some iOS devices, the reflective marble is invisible. That implies a shader compilation error but I sadly cannot check the console on there so we're just disabling them for all iOS devices.
	}

	addToGame() {
		let { game } = this;
		let { simulator, renderer } = game;

		renderer.scene.add(this.group);
		simulator.world.add(this.body);
		this.addedToGame = true;
	}

	getState(): MarbleState {
		return {
			entityType: 'marble',
			position: this.body.position.clone(),
			orientation: this.body.orientation.clone(),
			linearVelocity: this.body.linearVelocity.clone(),
			angularVelocity: this.body.angularVelocity.clone(),
			extras: {
				heldPowerUp: this.heldPowerUp?.id,
				helicopterEnableFrame: this.helicopterIsActive()? this.helicopterEnableFrame : undefined,
				superBounceEnableFrame: this.superBounceIsActive()? this.superBounceEnableFrame : undefined,
				shockAbsorberEnableFrame: this.shockAbsorberIsActive()? this.shockAbsorberEnableFrame : undefined,
				megaMarbleEnableFrame: this.megaMarbleIsActive()? this.megaMarbleEnableFrame : undefined,
				orientationQuat: this.orientationQuat.equals(new Quaternion())? undefined : this.orientationQuat.clone(),
				respawnFrame: this.respawnFrame || undefined,
				outOfBoundsFrame: this.outOfBoundsFrame ?? undefined,
				teleportStates: this.teleportStates.length ? this.teleportStates.map(x => ({
					trigger: x.trigger.id,
					entryFrame: x.entryFrame,
					exitFrame: x.exitFrame
				})) : undefined,
				teleportEnableTime: this.teleportEnableTime ?? undefined,
				teleportDisableTime: this.teleportDisableTime !== null && this.game.state.time - this.teleportDisableTime < TELEPORT_FADE_DURATION ? this.teleportDisableTime : undefined,
				blastAmount: this.blastAmount || undefined,
				inFinishState: this.inFinishState || undefined,
				spawnElementId: this.lastComputedSpawnElementId
			}
		};
	}

	getInitialState(): MarbleState {
		return {
			entityType: 'marble',
			position: this.spawnPosition.clone(),
			orientation: this.body.orientation.clone(), // Todo: Is this fine?
			linearVelocity: new Vector3(),
			angularVelocity: new Vector3(),
			extras: {
				spawnElementId: this.lastComputedSpawnElementId // Todo is this ok?? Argh initial state can be a wack concept sometimes!
			}
		};
	}

	loadState(state: MarbleState, { remote }: { remote: boolean }) {
		this.body.position.fromObject(state.position);
		this.body.orientation.fromObject(state.orientation);
		this.body.linearVelocity.fromObject(state.linearVelocity);
		this.body.angularVelocity.fromObject(state.angularVelocity);

		if (remote) {
			this.body.syncShapes();
			this.body.updateCollisions();
			this.internalStateNeedsStore = true;
		}

		this.heldPowerUp = this.game.getEntityById(state.extras.heldPowerUp) as PowerUp;

		this.helicopterEnableFrame = state.extras.helicopterEnableFrame ?? -Infinity;
		this.superBounceEnableFrame = state.extras.superBounceEnableFrame ?? -Infinity;
		this.shockAbsorberEnableFrame = state.extras.shockAbsorberEnableFrame ?? -Infinity;
		this.megaMarbleEnableFrame = state.extras.megaMarbleEnableFrame ?? -Infinity;

		let orientationQuat = state.extras.orientationQuat?
			new Quaternion().fromObject(state.extras.orientationQuat)
			: new Quaternion();
		let up = new Vector3(0, 0, 1).applyQuaternion(orientationQuat).normalize();

		let different = !this.orientationQuat.equals(orientationQuat);
		if (different) {
			// Start an animation
			let currentQuat = this.getInterpolatedOrientationQuat();
			this.oldOrientationQuat.copy(currentQuat);
			this.orientationChangeTime = this.game.state.time;
		}

		this.orientationQuat.copy(orientationQuat);

		this.currentUp.copy(up);
		let gravityStrength = this.body.gravity.length();
		this.body.gravity.copy(up).multiplyScalar(-1 * gravityStrength);

		let newRespawnFrame = state.extras.respawnFrame ?? 0;
		if (newRespawnFrame > this.respawnFrame) {
			this.game.simulator.executeNonDuplicatableEvent(() => {
				AudioManager.play('spawn.wav', undefined, undefined, this.body.position);
			}, `${this.id}respawnSound`, true);
		}
		this.respawnFrame = newRespawnFrame;

		if (this.outOfBoundsFrame === null && state.extras.outOfBoundsFrame !== undefined)
			this.goOutOfBounds(state.extras.outOfBoundsFrame);
		this.outOfBoundsFrame = state.extras.outOfBoundsFrame ?? null;

		this.teleportStates = (state.extras.teleportStates ?? []).map(x => ({
			trigger: this.game.getEntityById(x.trigger) as TeleportTrigger,
			entryFrame: x.entryFrame,
			exitFrame: x.exitFrame
		}));
		this.teleportEnableTime = state.extras.teleportEnableTime ?? null;
		this.teleportDisableTime = state.extras.teleportDisableTime ?? null;

		this.blastAmount = state.extras.blastAmount || 0;

		this.inFinishState = !!state.extras.inFinishState;

		this.computeSpawnPositionAndOrientation(state.extras.spawnElementId);
	}

	getInternalState(): InternalMarbleState {
		return {
			collisions: this.body.collisions.slice(),
			inContactCcd: this.body.inContactCcd,
			lastContactNormal: this.lastContactNormal.clone(),
			slidingTimeout: this.slidingTimeout,
			oldOrientationQuat: this.oldOrientationQuat.clone(),
			orientationQuat: this.orientationQuat.clone(),
			orientationChangeTime: this.orientationChangeTime,
			endPadColliderTimeout: this.endPadColliderTimeout
		};
	}

	loadInternalState(state: InternalMarbleState) {
		this.body.updateCollisions(state.collisions);
		this.body.inContactCcd = state.inContactCcd;
		this.lastContactNormal.copy(state.lastContactNormal);
		this.slidingTimeout = state.slidingTimeout;
		this.orientationQuat.copy(state.orientationQuat);
		this.oldOrientationQuat.copy(state.oldOrientationQuat);
		this.orientationChangeTime = state.orientationChangeTime;
		this.endPadColliderTimeout = state.endPadColliderTimeout;
	}

	update() {
		if (!this.addedToGame) return;

		// Always:
		this.stateNeedsStore = true;
		this.internalStateNeedsStore = true;

		if (this.controllingPlayer)
			this.currentControlState = this.controllingPlayer.controlState;

		if (
			this.outOfBoundsFrame !== null &&
			(this.currentControlState.using || this.game.state.frame - this.outOfBoundsFrame >= 2 * GAME_UPDATE_RATE) &&
			!(this.game.finishState.finished && this.game.finishState.isLegal)
		) {
			// Respawn the marble two seconds after having gone out of bounds
			if (this.game.type === 'singleplayer' && !this.checkpointState.currentCheckpoint && this.game.mode === GameMode.Normal && this === this.game.localPlayer.controlledMarble)
				this.game.state.restartFrames.push(this.game.state.frame + 1);
			else
				this.respawn(false);
		}

		let reconciling = this.game.simulator.isReconciling;

		if (this.shockAbsorberIsActive()) {
			// Show the shock absorber (takes precedence over super bounce)
			this.forcefield.setOpacity(1);
			this.shape.restitution = 0.01;  // Yep it's not actually zero

			if (!this.shockAbsorberSound && !reconciling) {
				this.shockAbsorberSound = AudioManager.createAudioSource('superbounceactive.wav', undefined, this.body.position);
				this.shockAbsorberSound.setLoop(true);
				this.shockAbsorberSound.play();
			}
		} else if (this.superBounceIsActive()) {
			// Show the super bounce
			this.forcefield.setOpacity(1);
			this.shape.restitution = 0.9;

			if (!reconciling) {
				this.shockAbsorberSound?.stop();
				this.shockAbsorberSound = null;
			}
		} else {
			// Stop both shock absorber and super bounce
			this.forcefield.setOpacity(0);
			this.shape.restitution = this.bounceRestitution;

			if (!reconciling) {
				this.shockAbsorberSound?.stop();
				this.shockAbsorberSound = null;
				this.superBounceSound?.stop();
				this.superBounceSound = null;
			}
		}
		if (this.superBounceIsActive() && !this.superBounceSound && !reconciling) {
			// Play the super bounce sound
			this.superBounceSound = AudioManager.createAudioSource('forcefield.wav', undefined, this.body.position);
			this.superBounceSound.setLoop(true);
			this.superBounceSound.play();
		}

		if (this.helicopterIsActive()) {
			// Show the helicopter
			this.helicopter.setOpacity(1);
			this.helicopter.setTransform(
				new Vector3(0, 0, this.radius - DEFAULT_RADIUS).applyQuaternion(this.orientationQuat),
				this.orientationQuat,
				new Vector3(1, 1, 1)
			);
			this.setGravityIntensity(this.game.mission.getDefaultGravity() * 0.25);

			if (!this.helicopterSound && !reconciling) {
				this.helicopterSound = AudioManager.createAudioSource('use_gyrocopter.wav', undefined, this.body.position);
				this.helicopterSound.setLoop(true);
				this.helicopterSound.play();
			}
		} else {
			// Stop the helicopter
			this.helicopter.setOpacity(0);
			this.setGravityIntensity(this.game.mission.getDefaultGravity() * 1);

			if (!reconciling) {
				this.helicopterSound?.stop();
				this.helicopterSound = null;
			}
		}

		if (this.megaMarbleIsActive()) {
			this.setRadius(MEGA_MARBLE_RADIUS);

			if (!reconciling) {
				this.rollingSound.stop();
				this.rollingMegaMarbleSound?.play();
			}
		} else {
			this.setRadius(this.game.mission.hasUltraMarble? ULTRA_RADIUS : DEFAULT_RADIUS);

			if (!reconciling) {
				this.rollingSound.play();
				this.rollingMegaMarbleSound?.stop();
			}
		}

		this.slidingTimeout--;

		// Handle teleporting
		for (let teleportState of this.teleportStates) {
			if (teleportState.entryFrame === null) continue;

			let delayInFrames = teleportState.trigger.delay * GAME_UPDATE_RATE / 1000;
			if (this.game.state.frame - teleportState.entryFrame >= delayInFrames) {
				// Execute the teleport
				teleportState.trigger.executeTeleport(this);
				continue;
			}

			// There's a little delay after exiting before the teleporter gets cancelled
			if (teleportState.exitFrame !== null && this.game.state.frame - teleportState.exitFrame > 0.05 * GAME_UPDATE_RATE) {
				// Cancel the teleport
				teleportState.entryFrame = null;
				teleportState.exitFrame = null;
				return;
			}
		}

		// Increase blast meter over time
		if (this.game.mission.hasBlast && this.blastAmount < 1)
			this.blastAmount = Util.clamp(this.blastAmount + 1000 / BLAST_CHARGE_TIME / GAME_UPDATE_RATE, 0, 1);

		if (this.inFinishState) this.body.gravity.multiplyScalar(0);
		if (this.endPadColliderTimeout > 0) this.endPadColliderTimeout--;

		if (!reconciling && this.inFinishState && this.finishCameraAnimationStart === null) {
			this.finishCameraAnimationStart = this.game.state.time;
			this.finishYaw = this.currentControlState.yaw;
			this.finishPitch = this.currentControlState.pitch;
		}

		Util.filterInPlace(this.teleportStates, x => x.entryFrame !== null || x.exitFrame !== null);
	}

	findBestCollision(withRespectTo: (c: Collision, normal: Vector3, otherShape: CollisionShape) => number) {
		let bestCollision: Collision;
		let bestCollisionValue = -Infinity;
		for (let collision of this.body.collisions) {
			if (collision.s1 !== this.shape && collision.s2 !== this.shape) continue; // Could also be an aux collider that caused the collision but we don't wanna count that here

			let otherShape = collision.s1 === this.shape ? collision.s2 : collision.s1;
			let normal = collision.s1 === this.shape ? collision.normal : collision.normal.clone().negate();
			let value = withRespectTo(collision, normal, otherShape);

			if (value > bestCollisionValue) {
				bestCollision = collision;
				bestCollisionValue = value;
			}
		}

		if (!bestCollision) return null;

		let contactNormal = bestCollision.normal;
		let contactShape = bestCollision.s2;
		if (bestCollision.s1 !== this.shape) {
			contactNormal = contactNormal.clone().negate();
			contactShape = bestCollision.s1;
		}

		// How much the current surface is pointing up
		let contactNormalUpDot = Math.abs(contactNormal.dot(this.currentUp));

		return { collision: bestCollision, contactNormal, contactShape, contactNormalUpDot };
	}

	onBeforeIntegrate(dt: number) {
		let controlState = this.currentControlState;
		let reconciling = this.game.simulator.isReconciling;
		let movementVec = new Vector3(controlState.movement.x, controlState.movement.y, 0);
		let inputStrength = movementVec.length();

		// Rotate the vector accordingly
		movementVec.multiplyScalar(MARBLE_ROLL_FORCE * 5 * dt);
		movementVec.applyAxisAngle(new Vector3(0, 0, 1), controlState.yaw);

		let quat = this.orientationQuat;
		movementVec.applyQuaternion(quat);

		// The axis of rotation (for angular velocity) is the cross product of the current up vector and the movement vector, since the axis of rotation is perpendicular to both.
		let movementRotationAxis = this.currentUp.clone().cross(movementVec);

		let bestCollision = this.findBestCollision((_, normal) => normal.dot(this.currentUp));

		if (bestCollision) {
			let { collision, contactNormal, contactNormalUpDot } = bestCollision;

			// The rotation necessary to get from the up vector to the contact normal.
			let contactNormalRotation = new Quaternion().setFromUnitVectors(this.currentUp, contactNormal);
			movementRotationAxis.applyQuaternion(contactNormalRotation);

			// Weaken the marble's angular power based on the friction and steepness of the surface
			let dot = -movementVec.clone().normalize().dot(contactNormal);
			let penalty = Math.max(0, dot - Math.max(0, (collision.s2Friction - 1.0)));
			movementRotationAxis.multiplyScalar(1 - penalty);

			// Apply angular velocity changes
			let angVel = this.body.angularVelocity;

			// Subtract the movement axis so it doesn't get slowed down
			let direction = movementRotationAxis.clone().normalize();
			let dot2 = Math.max(0, angVel.dot(direction));
			angVel.addScaledVector(direction, -dot2);

			// Subtract the "surface rotation axis", this ensures we can roll down hills quickly
			let surfaceRotationAxis = this.currentUp.clone().cross(contactNormal);
			let dot3 = Math.max(angVel.dot(surfaceRotationAxis), 0);
			angVel.addScaledVector(surfaceRotationAxis, -dot3);

			angVel.multiplyScalar(0.02 ** (Math.min(1, collision.friction) * dt)); // Handle velocity slowdown

			// Add them back
			angVel.addScaledVector(surfaceRotationAxis, dot3);
			angVel.addScaledVector(direction, dot2);

			if (angVel.length() > 300 * this.speedFac) angVel.multiplyScalar(300 * this.speedFac / angVel.length()); // Absolute max angular speed

			if (dot2 + movementRotationAxis.length() > 12 * Math.PI*2 * inputStrength / contactNormalUpDot * this.speedFac) {
				// Cap the rolling velocity
				let newLength = Math.max(0, 12 * Math.PI*2 * inputStrength / contactNormalUpDot * this.speedFac - dot2);
				movementRotationAxis.normalize().multiplyScalar(newLength);
			}
		} else {
			// Handle airborne movement
			// Angular acceleration isn't quite as speedy
			movementRotationAxis.multiplyScalar(1/2);

			let airMovementVector = movementVec.clone();
			let airVelocity = this.helicopterIsActive()? 5 : 3.2; // Change air velocity for the helicopter
			if (this.inFinishState) airVelocity = 0;
			airMovementVector.multiplyScalar(airVelocity * dt);
			this.body.linearVelocity.add(airMovementVector);

			if (!reconciling) {
				// todo
				//this.slidingSound.gain.gain.value = 0;
				//this.rollingSound.gain.gain.linearRampToValueAtTime(0, AudioManager.context.currentTime + 0.02);
				//this.rollingMegaMarbleSound?.gain.gain.linearRampToValueAtTime(0, AudioManager.context.currentTime + 0.02);
			}
		}

		movementRotationAxis.multiplyScalar(this.speedFac);
		// Apply angular acceleration, but make sure the angular velocity doesn't exceed some maximum
		Util.addToVectorCapped(this.body.angularVelocity, movementRotationAxis, 120 * this.speedFac);

		if (this.inFinishState) this.body.linearVelocity.multiplyScalar(dt / (1 / GAME_UPDATE_RATE) * 0.9);

		if (controlState.using && this.heldPowerUp) {
			this.heldPowerUp.use(this, 0);
			this.heldPowerUp.useCosmetically(this);
			this.unequipPowerUp();
		}
		if (controlState.blasting) this.useBlast();
	}

	onAfterIntegrate() {
		// We'll need these for collision response lata
		this.beforeVel.copy(this.body.linearVelocity);
		this.beforeAngVel.copy(this.body.angularVelocity);

		if (this.game.state.frame - this.game.state.lastRestartFrame < 3.5 * GAME_UPDATE_RATE && this.controllingPlayer) {
			// Lock the marble to the space above the start pad

			let position = this.body.position;
			position.x = this.spawnPosition.x;
			position.y = this.spawnPosition.y;

			let vel = this.body.linearVelocity;
			vel.x = vel.y = 0;

			let angVel = this.body.angularVelocity;
			// Cap the angular velocity so it doesn't go haywire
			if (angVel.length() > 60) angVel.normalize().multiplyScalar(60);

			this.shape.friction = 0;
		} else {
			this.shape.friction = 1;
		}
	}

	onBeforeCollisionResponse() {
		// Create bounce particles
		let mostPowerfulCollision = this.findBestCollision((_, normal, otherShape) => {
			return -normal.dot(this.body.linearVelocity.clone().sub(otherShape.body.linearVelocity));
		});
		if (!mostPowerfulCollision || mostPowerfulCollision.collision.s1 !== this.shape) return; // We don't want marble-marble collisions to be processed twice, once by each marble, but we let one marble do it for both

		let impactVelocity = -mostPowerfulCollision.contactNormal.dot(this.body.linearVelocity.clone().sub(mostPowerfulCollision.contactShape.body.linearVelocity));
		if (impactVelocity > 6) this.showBounceParticles();

		// Handle bounce sound
		let volume = Util.clamp((impactVelocity / 12)**1.5, 0, 1);
		if (impactVelocity > 1) {
			// Play a collision impact sound
			this.playBounceSound(volume);
			//if (this.level.replay.canStore) this.level.replay.bounceTimes.push({ tickIndex: this.level.replay.currentTickIndex, volume: volume, showParticles: impactVelocity > 6 });
		}

		// Check for marble-marble collisions
		for (let collision of this.body.collisions) {
			let shapes = [collision.s1, collision.s2];
			if (!shapes.includes(this.shape)) continue;
			if (shapes[0] !== this.shape) shapes.reverse();
			if (!(shapes[1] instanceof BallCollisionShape)) continue;
			if (!(shapes[1].body.userData instanceof Marble)) continue;

			let otherMarble = shapes[1].body.userData as Marble;
			this.onMarbleMarbleCollision(otherMarble, collision);
		}
	}

	onAfterCollisionResponse() {
		let bestCollision = this.findBestCollision((_, normal) => normal.dot(this.currentUp));
		if (!bestCollision) return;

		let { collision, contactNormal, contactShape, contactNormalUpDot } = bestCollision;

		this.lastContactNormal.copy(contactNormal);

		let lastSurfaceRelativeVelocity = this.beforeVel.clone().sub(contactShape.body.linearVelocity);
		let surfaceRelativeVelocity = this.body.linearVelocity.clone().sub(contactShape.body.linearVelocity);
		let maxDotSlide = 0.5; // 30°
		let reconciling = this.game.simulator.isReconciling;

		// Implements sliding: If we hit the surface at an angle below 45°, and have movement keys pressed, we don't bounce.
		let dot0 = -contactNormal.dot(lastSurfaceRelativeVelocity.clone().normalize());
		let slidingEligible = contactNormalUpDot > 0.1; // Kinda arbitrary rn, it's about 84°, definitely makes sure we don't slide on walls
		if (slidingEligible && this.slidingTimeout <= 0 && dot0 > 0.001 && dot0 <= maxDotSlide && this.currentControlState.movement.length() > 0) {
			let dot = contactNormal.dot(surfaceRelativeVelocity);
			let linearVelocity = this.body.linearVelocity;
			let originalLength = linearVelocity.length();
			linearVelocity.addScaledVector(contactNormal, -dot); // Remove all velocity in the direction of the surface normal

			let newLength = linearVelocity.length();
			let diff = originalLength - newLength;
			linearVelocity.normalize().multiplyScalar(newLength + diff * 2); // Give a small speedboost
		}

		// If we're using a shock absorber or we're on a low-restitution surface, give the marble a velocity boost on contact based on its angular velocity.
		outer:
		if (collision.restitution < 0.5) {
			let dot = -this.beforeVel.dot(contactNormal);
			if (dot < 0) break outer;

			let boost = this.beforeAngVel.clone().cross(contactNormal).multiplyScalar(2 * (0.5 - collision.restitution) * dot / 300 / 0.98); // 0.98 fac because shock absorber used to have 0 rest but now 0.01
			this.body.linearVelocity.add(boost);
		}

		// Create a certain velocity boost on collisions with walls based on angular velocity. This assists in making wall-hits feel more natural.
		let angularBoost = this.body.angularVelocity.clone().cross(contactNormal).multiplyScalar((1 - Math.abs(contactNormalUpDot)) * contactNormal.dot(this.body.linearVelocity) / (Math.PI * 2) / 15);
		if (angularBoost.length() >= 0.01) {
			// Remove a bit of the current velocity so that the response isn't too extreme
			let currentVelocity = this.body.linearVelocity;
			let ratio = angularBoost.length() / currentVelocity.length();
			currentVelocity.multiplyScalar(1 / (1 + ratio * 0.5)).add(angularBoost);
		}

		// Handle jumping
		if (this.currentControlState.jumping && contactNormalUpDot > 1e-6) {
			this.setLinearVelocityInDirection(contactNormal, this.jumpImpulse + contactShape.body.linearVelocity.dot(contactNormal), true, () => {
				this.playJumpSound();
			});
		}

		// Handle rolling and sliding sounds
		if (0 !== 0 && !reconciling) { // TODO.
			if (contactNormal.dot(surfaceRelativeVelocity) < 0.01) {
				let predictedMovement = this.body.angularVelocity.clone().cross(this.currentUp).multiplyScalar(1 / Math.PI / 2);
				// The expected movement based on the current angular velocity. If actual movement differs too much, we consider the marble to be "sliding".

				if (predictedMovement.dot(surfaceRelativeVelocity) < -0.00001 || (predictedMovement.length() > 0.5 && predictedMovement.length() > surfaceRelativeVelocity.length() * 1.5)) {
					this.slidingSound.gain.gain.value = 0.6;
					this.rollingSound.gain.gain.value = 0;
					if (this.rollingMegaMarbleSound) this.rollingMegaMarbleSound.gain.gain.value = 0;
				} else {
					this.slidingSound.gain.gain.value = 0;
					let pitch = Util.clamp(surfaceRelativeVelocity.length() / 15, 0, 1) * 0.75 + 0.75;

					this.rollingSound.gain.gain.linearRampToValueAtTime(Util.clamp(pitch - 0.75, 0, 1), AudioManager.context.currentTime + 0.02);
					this.rollingMegaMarbleSound?.gain.gain.linearRampToValueAtTime(Util.clamp(pitch - 0.75, 0, 1), AudioManager.context.currentTime + 0.02);
					this.rollingSound.setPlaybackRate(pitch);
					this.rollingMegaMarbleSound?.setPlaybackRate(pitch);
				}
			} else {
				this.slidingSound.gain.gain.value = 0;
				this.rollingSound.gain.gain.linearRampToValueAtTime(0, AudioManager.context.currentTime + 0.02);
				this.rollingMegaMarbleSound?.gain.gain.linearRampToValueAtTime(0, AudioManager.context.currentTime + 0.02);
			}
		}
	}

	postUpdate() {
		if (!this.game.simulator.isReconciling) {
			if (this.interpolationRemaining-- <= 0) {
				this.interpolatedPosition.copy(this.body.position);
				this.interpolatedOrientation.copy(this.body.orientation);
			} else {
				this.interpolatedPosition.addScaledVector(this.body.linearVelocity, 1 / GAME_UPDATE_RATE);
				this.interpolatedPosition.lerp(this.body.position, this.interpolationStrength);

				this.interpolatedOrientation.slerp(this.body.orientation, this.interpolationStrength);
			}

			//this.calculatePredictiveTransforms();
		}
	}

	onMarbleMarbleCollision(otherMarble: Marble, collision: Collision) {
		this.affect(otherMarble);

		// Set restitution for marble-marble collisions
		collision.restitution = 1;

		// Set custom collision code for mega marble goodness
		if (this.megaMarbleIsActive() !== otherMarble.megaMarbleIsActive()) {
			collision.customVelocitySolver = () => {
				// https://github.com/MBU-Team/OpenMBU/blob/96061f8d1bb03ede1a7119c139927402f77692f0/engine/source/game/marble/marblephysics.cpp#L379

				let ourMass = collision.s1.mass;
				let theirMass = collision.s2.mass;
				let bounce = 1;

				let dp = collision.s1.body.linearVelocity.clone().multiplyScalar(ourMass).addScaledVector(collision.s2.body.linearVelocity, -theirMass);
				let normP = collision.normal.clone().multiplyScalar(dp.dot(collision.normal));
				normP.multiplyScalar(bounce + 1);

				collision.s1.body.linearVelocity.addScaledVector(normP, -1 / ourMass);
				collision.s2.body.linearVelocity.addScaledVector(normP, 1 / theirMass);
			};
		}
	}

	/** Get the current interpolated orientation quaternion. */
	getInterpolatedOrientationQuat() {
		let completion = Util.clamp((this.game.state.time - this.orientationChangeTime) / 0.3, 0, 1);
		return this.oldOrientationQuat.clone().slerp(this.orientationQuat, completion);
	}

	setGravityIntensity(intensity: number) {
		let gravityVector = this.currentUp.clone().multiplyScalar(-1 * intensity);
		this.body.gravity.copy(gravityVector); // todo temp whatever
	}

	/** Sets the current up vector and gravity with it. */
	setUp(newUp: Vector3, instant = false) {
		let time = this.game.state.time;

		newUp.normalize(); // We never know 👀
		this.currentUp.copy(newUp);
		let gravityStrength = this.body.gravity.length();
		this.body.gravity.copy(newUp).multiplyScalar(-1 * gravityStrength);

		let currentQuat = this.getInterpolatedOrientationQuat();
		let oldUp = this.oldUp = new Vector3(0, 0, 1);
		oldUp.applyQuaternion(currentQuat);

		let quatChange = new Quaternion();
		let dot = newUp.dot(oldUp);
		if (dot <= -(1 - 1e-15)/* && !(this.replay.version < 3)*/) { // TODO If the old and new up are exact opposites, there are infinitely many possible rotations we could do. So choose the one that maintains the current look vector the best. Replay check so we don't break old stuff.
			let lookVector = new Vector3(0, 0, 1).applyQuaternion(this.game.renderer.camera.orientation);
			let intermediateVector = oldUp.clone().cross(lookVector).normalize();

			// First rotation to the intermediate vector, then rotate from there to the new up
			quatChange.setFromUnitVectors(oldUp, intermediateVector);
			quatChange.multiplyQuaternions(new Quaternion().setFromUnitVectors(intermediateVector, newUp), quatChange);
		} else {
			// Instead of calculating the new quat from nothing, calculate it from the last one to guarantee the shortest possible rotation.
			quatChange.setFromUnitVectors(oldUp, newUp);
		}

		this.orientationQuat = quatChange.multiply(currentQuat);
		this.oldOrientationQuat = currentQuat;
		this.orientationChangeTime = instant? -Infinity : time;
	}

	playJumpSound() {
		this.game.simulator.executeNonDuplicatableEvent(() => {
			AudioManager.play(['jump.wav'], undefined, undefined, this.body.position);
		}, `${this.id}jump`);
	}

	playBounceSound(volume: number) {
		return; // temp
		this.game.simulator.executeNonDuplicatableEvent(() => {
			let prefix = (this.radius === MEGA_MARBLE_RADIUS)? 'mega_' : '';
			AudioManager.play(['bouncehard1.wav', 'bouncehard2.wav', 'bouncehard3.wav', 'bouncehard4.wav'].map(x => prefix + x), volume, undefined, this.body.position.clone());
		}, `${this.id}bounceSound`);
	}

	showBounceParticles() {
		this.game.simulator.executeNonDuplicatableEvent(() => {
			this.game.renderer.particles.createEmitter(bounceParticleOptions, this.body.position, null,
				new Vector3(1, 1, 1).addScaledVector(this.currentUp.clone().abs(), -0.8));
		}, `${this.id}bounceParticles`);
	}

	/** Sets linear velocity in a specific direction, but capped. Used for things like jumping and bumpers. */
	setLinearVelocityInDirection(direction: Vector3, magnitude: number, onlyIncrease: boolean, onIncrease: () => any = () => {}) {
		let unitVelocity = this.body.linearVelocity.clone().normalize();
		let dot = unitVelocity.dot(direction);
		let directionalSpeed = dot * this.body.linearVelocity.length();

		if (directionalSpeed < magnitude || !onlyIncrease) {
			let velocity = this.body.linearVelocity;
			velocity.addScaledVector(direction, -directionalSpeed);
			velocity.addScaledVector(direction, magnitude);

			if (directionalSpeed < magnitude) onIncrease();
		}
	}

	/** Predicts the position of the marble in the next physics tick to allow for smooth, interpolated rendering. */
	calculatePredictiveTransforms() {
		let pos = this.body.position;
		let orientation = this.body.orientation;
		let linVel = this.body.linearVelocity;
		let angVel = this.body.angularVelocity;

		// Naive: Just assume the marble moves as if nothing was in its way and it continued with its current velocity.
		let predictedPosition = pos.clone().addScaledVector(linVel, 1 / GAME_UPDATE_RATE).addScaledVector(this.body.gravity, 1 / GAME_UPDATE_RATE**2 / 2);
		let movementDiff = predictedPosition.clone().sub(pos);

		let dRotation = angVel.clone().multiplyScalar(1 / GAME_UPDATE_RATE);
		let dRotationLength = dRotation.length();
		let dq = new Quaternion().setFromAxisAngle(dRotation.normalize(), dRotationLength);
		let predictedOrientation = dq.multiply(orientation);

		// See if we hit something, do this to prevent clipping through things
		let hits = this.game.simulator.world.castShape(this.shape, movementDiff, 1);
		let hit = hits.find(x => !this.body.collisions.some(y => y.s2 === x.shape)); // Filter out hits with shapes we're already touching
		let lambda = hit?.lambda ?? 1;

		this.predictedPosition.lerpVectors(pos, predictedPosition, lambda);
		this.predictedOrientation.copy(orientation).slerp(predictedOrientation, lambda);
	}

	render() {
		let time = this.game.state.time;

		// todo: Position based on current and predicted position and orientation
		//this.group.position.copy(this.body.position).lerp(this.predictedPosition, this.game.state.subtickCompletion);
		//this.innerGroup.orientation.copy(this.body.orientation).slerp(this.predictedOrientation, this.game.state.subtickCompletion)
		this.group.position.copy(this.interpolatedPosition);
		this.innerGroup.orientation.copy(this.interpolatedOrientation);

		this.group.recomputeTransform();
		this.innerGroup.recomputeTransform();

		this.forcefield.render();
		if (this.helicopterIsActive()) this.helicopter.render();

		// Update the teleporting look:

		let teleportFadeCompletion = 0;

		if (this.teleportEnableTime !== null) teleportFadeCompletion = Util.clamp((time - this.teleportEnableTime) / TELEPORT_FADE_DURATION, 0, 1);
		if (this.teleportDisableTime !== null) teleportFadeCompletion = Util.clamp(1 - (time - this.teleportDisableTime) / TELEPORT_FADE_DURATION, 0, 1);

		if (teleportFadeCompletion > 0) {
			this.sphere.opacity = Util.lerp(1, 0.25, teleportFadeCompletion);
		} else {
			this.sphere.opacity = Number(!this.ballShape);
		}
	}

	renderReflection() {
		if (!this.isReflective()) return;

		this.cubeCamera.position.copy(this.group.position);
		this.cubeMap.render(this.game.renderer.scene, this.cubeCamera, 4);
	}

	enableSuperBounce() {
		this.superBounceEnableFrame = this.game.state.frame;
	}

	enableShockAbsorber() {
		this.shockAbsorberEnableFrame = this.game.state.frame;
	}

	enableHelicopter() {
		this.helicopterEnableFrame = this.game.state.frame;
	}

	enableMegaMarble() {
		if (!this.megaMarbleIsActive())
			this.body.linearVelocity.addScaledVector(this.currentUp, 6); // There's a small yeet upwards

		this.megaMarbleEnableFrame = this.game.state.frame;
	}

	superBounceIsActive() {
		return this.game.state.frame - this.superBounceEnableFrame < 5 * GAME_UPDATE_RATE;
	}

	shockAbsorberIsActive() {
		return this.game.state.frame - this.shockAbsorberEnableFrame < 5 * GAME_UPDATE_RATE;
	}

	helicopterIsActive() {
		return this.game.state.frame - this.helicopterEnableFrame < 5 * GAME_UPDATE_RATE;
	}

	megaMarbleIsActive() {
		return this.game.state.frame - this.megaMarbleEnableFrame < 10 * GAME_UPDATE_RATE;
	}

	enableTeleportingLook() {
		let completion = (this.teleportDisableTime !== null)? Util.clamp((this.game.state.time - this.teleportDisableTime) / TELEPORT_FADE_DURATION, 0, 1) : 1;
		this.teleportEnableTime = this.game.state.time - TELEPORT_FADE_DURATION * (1 - completion);
		this.teleportDisableTime = null;
	}

	disableTeleportingLook() {
		let completion = Util.clamp((this.game.state.time - this.teleportEnableTime) / TELEPORT_FADE_DURATION, 0, 1) ?? 1;
		this.teleportDisableTime = this.game.state.time - TELEPORT_FADE_DURATION * (1 - completion);
		this.teleportEnableTime = null;
	}

	pickUpPowerUp(powerUp: PowerUp) {
		if (!powerUp) return false;
		if (this.heldPowerUp && powerUp.constructor === this.heldPowerUp.constructor) return false;

		this.heldPowerUp = powerUp;
		G.menu.hud.setPowerupButtonState(true);

		return true;
	}

	unequipPowerUp() {
		if (!this.heldPowerUp) {
			G.menu.hud.setPowerupButtonState(false);
			return;
		}
		this.heldPowerUp = null;
		G.menu.hud.setPowerupButtonState(false);
	}

	goOutOfBounds(frame = this.game.state.frame) {
		if (this.outOfBoundsFrame !== null || this.inFinishState) return;

		// I guess this is fine?
		this.game.simulator.executeNonDuplicatableEvent(() => {
			this.game.renderer.updateCamera(); // Update the camera at the point of OOB-ing
			this.outOfBoundsCameraPosition = this.game.renderer.camera.position.clone();

			AudioManager.play('whoosh.wav', undefined, undefined, this.body.position.clone());
		}, `${this.id}whoosh`, true);

		G.menu.hud.setPowerupButtonState(true);
		this.outOfBoundsFrame = frame;
	}

	enableFinishState() {
		if (this.inFinishState) return;
		this.inFinishState = true;
	}

	useBlast() {
		if (this.blastAmount < 0.2 || !this.game.mission.hasBlast) return;

		let impulse = this.currentUp.clone().multiplyScalar(Math.max(Math.sqrt(this.blastAmount), this.blastAmount) * 10);
		this.body.linearVelocity.add(impulse);

		for (let marble of this.game.marbles) {
			if (marble === this) continue;

			let knockbackStrength = this.blastAmount * (this.blastAmount > 1 ? 10 : 5);
			if (this.body.position.distanceTo(marble.body.position) < knockbackStrength) {
				let dir = marble.body.position.clone().sub(this.body.position);
				dir.normalize().multiplyScalar(knockbackStrength);
				marble.body.linearVelocity.add(dir);

				this.affect(marble);
			}
		}

		this.game.simulator.executeNonDuplicatableEvent(() => {
			AudioManager.play('blast.wav', undefined, undefined, this.body.position);
			this.game.renderer.particles.createEmitter(
				(this.blastAmount > 1)? blastMaxParticleOptions : blastParticleOptions,
				null,
				() => this.body.position.clone().addScaledVector(this.currentUp, -this.radius * 0.4),
				new Vector3(1, 1, 1).addScaledVector(this.currentUp.clone().abs(), -0.8)
			);
		}, `${this.id}blast`);

		this.blastAmount = 0;
	}

	getTeleportState(trigger: TeleportTrigger) {
		let existing = this.teleportStates.find(x => x.trigger === trigger);
		if (existing) return existing;

		this.teleportStates.push({
			trigger: trigger,
			entryFrame: null,
			exitFrame: null
		});
		return Util.last(this.teleportStates);
	}

	/** Updates the radius of the marble both visually and physically. */
	setRadius(radius: number) {
		if (this.radius === radius) return;

		this.radius = radius;
		this.sphere.scale.setScalar(radius);
		this.sphere.recomputeTransform();
		this.ballShape?.setTransform(new Vector3(), new Quaternion(), new Vector3().setScalar(radius / DEFAULT_RADIUS));

		this.shape.radius = radius;
		this.shape.updateInertiaTensor();
		this.largeAuxShape.radius = 2 * radius;
		this.smallAuxShape.radius = radius;

		this.shape.mass = radius === MEGA_MARBLE_RADIUS ? 5 : 1;
		this.shape.updateInertiaTensor();

		this.body.syncShapes();

		this.forcefield.group.scale.setScalar(this.radius / DEFAULT_RADIUS);
		this.forcefield.group.recomputeTransform();
	}

	restart(frame: number, fromRespawn = false) {
		this.computeSpawnPositionAndOrientation(this.selectSpawnElement(!fromRespawn));

		super.restart(frame);

		// temp lmao
		if (!this.controllingPlayer) this.body.position.set((Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20, 20 + (Math.random() - 0.5) * 20);

		if (!this.addedToGame) this.addToGame();

		this.slidingTimeout = 0;
		this.lastContactNormal.set(0, 0, 0);
		this.finishCameraAnimationStart = null;
		this.setUp(new Vector3(0, 0, 1), true);
		this.cancelInterpolation();

		if (this.controllingPlayer) {
			this.controllingPlayer.yaw = DEFAULT_YAW + this.spawnRotation.z;
			this.controllingPlayer.pitch = DEFAULT_PITCH;
		}

		this.game.simulator.executeNonDuplicatableEvent(() => {
			AudioManager.play('spawn.wav', undefined, undefined, this.body.position);
		}, `${this.id}respawnSound`, true);

		G.menu.hud.displayHelp(() => {
			if (this.controllingPlayer !== this.game.localPlayer) return null;
			return this.game.mission.missionInfo.starthelptext ?? null;
		}, this.game.state.frame, false);
	}

	respawn(ignoreCheckpointState: boolean) {
		if (this.checkpointState.currentCheckpoint && !ignoreCheckpointState) {
			// There's a checkpoint, so load its state instead
			this.checkpointState.load();
			return;
		}

		// Unpickup all gems picked up by this marble
		for (let gem of this.game.shapes) {
			if (!(gem instanceof Gem)) continue;
			if (gem.pickUpHistory.includes(this)) {
				gem.pickDown();
				this.affect(gem);
			}
		}

		this.restart(this.game.state.frame, true);
	}

	selectSpawnElement(first: boolean) {
		let { game } = this;

		let startPad = Util.findLast(game.shapes, (shape) => shape instanceof StartPad);
		if (startPad) return startPad.id;

		let spawnPoints = game.mission.allElements.find(x => x._name === "SpawnPoints") as MissionElementSimGroup;
		if (!spawnPoints) return null;

		if (first) return spawnPoints.elements[Math.floor(Util.seededRandom(game.seed + this.id + game.state.timesRestarted) * spawnPoints.elements.length)]._id;

		let closest: MissionElementTrigger = null;
		let closestDist = Infinity;

		// Find the spawn trigger closest to the current marble position
		for (let spawnTrigger of spawnPoints.elements) {
			// todo: different logic for "quick respawns" in hunt situations
			let pos = MisUtils.parseVector3((spawnTrigger as MissionElementTrigger).position);
			let dist = this.body.position.distanceToSquared(pos);
			if (dist >= closestDist) continue;

			closest = spawnTrigger as MissionElementTrigger;
			closestDist = dist;
		}

		return closest && closest._id;
	}

	computeSpawnPositionAndOrientation(spawnElementId: number) {
		if (this.lastComputedSpawnElementId === spawnElementId) return;
		this.lastComputedSpawnElementId = spawnElementId;

		let { game } = this;

		let element = game.mission.allElements.find(x => x._id === spawnElementId);
		if (!element) {
			// If there isn't anything, start at this weird point
			this.spawnPosition.set(0, 0, 300);
			this.spawnRotation.set(0, 0, 0);
		} else {
			this.spawnPosition.copy(MisUtils.parseVector3((element as any).position));
			this.spawnPosition.z += 3;
			this.spawnRotation.setFromQuaternion(MisUtils.parseRotation((element as any).rotation), "ZXY");
		}
	}

	stop() {
		this.rollingSound?.stop();
		this.slidingSound?.stop();
		this.helicopterSound?.stop();
		this.shockAbsorberSound?.stop();
		this.superBounceSound?.stop();
	}

	dispose() {
		this.cubeMap?.dispose();
	}

	beforeReconciliation() {
		this.reconciliationPosition.copy(this.body.position);
	}

	afterReconciliation() {
		let frames = (this.game as MultiplayerGame).state.frameGap * 2;
		frames = Math.max(frames, 20); // 20 is totally fine as lower bound, still looks good

		if (this.interpolationRemaining > frames) return;
		if (this.reconciliationPosition.distanceTo(this.body.position) === 0) return;

		this.interpolationRemaining = frames;
		this.interpolationStrength = 1 - Math.pow(1 - 0.99, 1 / this.interpolationRemaining);
	}

	cancelInterpolation() {
		this.interpolationRemaining = 0;
		this.reconciliationPosition.copy(this.body.position);
	}

	static getPassiveControlState(): MarbleControlState {
		return {
			movement: new Vector2(),
			yaw: DEFAULT_YAW,
			pitch: DEFAULT_PITCH,
			jumping: false,
			using: false,
			blasting: false
		};
	}
}