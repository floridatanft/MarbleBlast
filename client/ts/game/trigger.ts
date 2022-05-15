import { MissionElementTrigger, MisParser } from "../../../shared/mis_parser";
import { Util } from "../util";
import { AudioManager } from "../audio";
import { ConvexHullCollisionShape } from "../physics/collision_shape";
import { RigidBody, RigidBodyType } from "../physics/rigid_body";
import { Vector3 } from "../math/vector3";
import { Box3 } from "../math/box3";
import { Matrix4 } from "../math/matrix4";
import { Game } from "./game";
import { Entity } from "./entity";
import { EntityState } from "../../../shared/game_server_format";
import { Marble } from "./marble";
import { MisUtils } from "../parsing/mis_utils";

interface InternalTriggerState {
	currentlyColliding: Set<RigidBody>
}

/** A trigger is a cuboid-shaped area whose overlap with the marble causes certain events to happen. */
export abstract class Trigger extends Entity {
	vertices: Vector3[];
	body: RigidBody;
	element: MissionElementTrigger;
	sounds: string[] = [];
	currentlyColliding = new Set<RigidBody>();

	constructor(element: MissionElementTrigger, game: Game) {
		super(game);

		this.id = element._id;
		this.element = element;
		this.game = game;

		// Parse the "polyhedron"
		let coordinates = MisUtils.parseNumberList(element.polyhedron);
		let origin = new Vector3(coordinates[0], coordinates[1], coordinates[2]);
		let d1 = new Vector3(coordinates[3], coordinates[4], coordinates[5]);
		let d2 = new Vector3(coordinates[6], coordinates[7], coordinates[8]);
		let d3 = new Vector3(coordinates[9], coordinates[10], coordinates[11]);

		// Create the 8 points of the parallelepiped
		let p1 = origin.clone();
		let p2 = origin.clone().add(d1);
		let p3 = origin.clone().add(d2);
		let p4 = origin.clone().add(d3);
		let p5 = origin.clone().add(d1).add(d2);
		let p6 = origin.clone().add(d1).add(d3);
		let p7 = origin.clone().add(d2).add(d3);
		let p8 = origin.clone().add(d1).add(d2).add(d3);

		let mat = new Matrix4();
		mat.compose(MisUtils.parseVector3(element.position), MisUtils.parseRotation(element.rotation), MisUtils.parseVector3(element.scale));

		// Apply the transformation matrix to each vertex
		let vertices = [p1, p2, p3, p4, p5, p6, p7, p8].map(x => x.applyMatrix4(mat));
		this.vertices = vertices;

		// Triggers ignore the actual shape of the polyhedron and simply use its AABB.
		let aabb = new Box3().setFromPoints(vertices);

		let aabbVertices = Util.getBoxVertices(aabb);

		// Create the collision geometry
		let ownShape = new ConvexHullCollisionShape(aabbVertices);
		ownShape.collisionDetectionMask = 0b100; // Collide with the small aux marble

		let body = new RigidBody();
		body.type = RigidBodyType.Static;
		body.evaluationOrder = this.id;
		body.addCollisionShape(ownShape);

		this.body = body;

		// Init collision handlers

		body.onBeforeIntegrate = () => {
			for (let body of this.currentlyColliding) {
				if (!this.body.collisions.some(x => x.s1.body === body)) {
					this.currentlyColliding.delete(body);
					this.internalStateNeedsStore = true;

					let marble = body.userData as Marble;
					this.onMarbleLeave(marble);
				}
			}
		};

		body.onBeforeCollisionResponse = () => {
			for (let collision of this.body.collisions) {
				let marble = collision.s1.body.userData as Marble;

				if (!this.currentlyColliding.has(collision.s1.body)) this.onMarbleEnter(marble);
				this.onMarbleInside(marble);

				this.currentlyColliding.add(collision.s1.body);
				this.internalStateNeedsStore = true;
			}
		};

		this.reset();
	}

	async init() {
		// Preload all sounds
		for (let sound of this.sounds) {
			await AudioManager.loadBuffer(sound);
		}
	}

	reset() {
		this.currentlyColliding.clear();
	}

	render() {}
	stop() {}

	getInternalState(): InternalTriggerState {
		return {
			currentlyColliding: new Set(this.currentlyColliding)
		};
	}

	loadInternalState(state: InternalTriggerState) {
		this.currentlyColliding = new Set(state.currentlyColliding);
	}

	onMarbleInside(marble: Marble) {}
	onMarbleEnter(marble: Marble) {}
	onMarbleLeave(marble: Marble) {}
	update() {}
}