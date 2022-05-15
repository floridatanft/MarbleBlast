import { GAME_UPDATE_RATE } from "../../../shared/constants";
import { DefaultMap } from "../../../shared/default_map";
import { EntityUpdate } from "../../../shared/game_server_format";
import { G } from "../global";
import { Util } from "../util";
import { Game } from "./game";
import { Entity } from "./entity";
import { Marble } from "./marble";
import { Gem } from "./shapes/gem";
import { GameMode } from "./game_mode";

interface AffectionEdge {
	id: number,
	from: Entity,
	to: Entity,
	frame: number
}

export const READY_TIME = 0.5;
export const SET_TIME = 2.0;
export const GO_TIME = 3.5;

export class GameState {
	game: Game;
	id = 0;

	frame = -1;
	maxFrame = -1;
	restartFrames: number[] = [];

	get lastRestartFrame() {
		let restartFrame = -Infinity;

		for (let i = 0; i < this.restartFrames.length; i++) {
			if (this.restartFrames[i] > this.frame) break;
			restartFrame = this.restartFrames[i];
		}

		return restartFrame;
	}

	get time() {
		return (this.frame + this.subframeCompletion) / GAME_UPDATE_RATE;
	}

	subframeCompletion = 0;

	stateHistory = new DefaultMap<number, EntityUpdate[]>(() => []);
	internalStateHistory = new DefaultMap<number, { frame: number, state: any }[]>(() => []);
	affectionGraph: AffectionEdge[] = [];

	nextUpdateId = 0;
	nextAffectionEdgeId = 0;

	constructor(game: Game) {
		this.game = game;
	}

	recordEntityInteraction(e1: Entity, e2: Entity) {
		this.affectionGraph.push({
			id: this.nextAffectionEdgeId++,
			from: e1,
			to: e2,
			frame: this.frame
		});

		const propagate = (e: Entity) => {
			let keepGoing = false;

			for (let player of e1.affectedBy) {
				if (!e.affectedBy.has(player)) {
					e.affectedBy.add(player);
					keepGoing = true;
				}
			}

			if (keepGoing) for (let edge of this.affectionGraph) if (edge.from === e) propagate(edge.to);
		};
		propagate(e2);
	}

	restart(frame: number) {
		let { game } = this;

		for (let entity of game.entities) {
			if (!entity.restartable) continue;
			entity.restart(frame);
		}

		G.menu.finishScreen.hide();
		if (!Util.isTouchDevice) Util.requestPointerLock(); // Oof honestly I don't think this will trigger, maybe find a hack to trigger it through some custom event shit
	}

	saveStates() {
		for (let i = 0; i < this.game.entities.length; i++) {
			let entity = this.game.entities[i];

			if (entity.stateNeedsStore) {
				let arr = this.stateHistory.get(entity.id);
				if (Util.last(arr)?.frame === this.frame) arr.pop();

				let stateUpdate: EntityUpdate = {
					updateId: this.nextUpdateId++,
					entityId: entity.id,
					frame: this.frame,
					state: entity.getState()
				};
				arr.push(stateUpdate);

				entity.stateNeedsStore = false;
			}

			if (entity.internalStateNeedsStore) {
				let arr = this.internalStateHistory.get(entity.id);
				if (Util.last(arr)?.frame === this.frame) arr.pop();

				arr.push({
					frame: (arr.length === 0)? -1 : this.frame,
					state: entity.getInternalState()
				});

				entity.internalStateNeedsStore = false;
			}
		}
	}

	getLastEntityUpdate(entity: Entity, upToFrame: number) {
		let history = this.stateHistory.get(entity.id);
		let update = history && Util.findLast(history, x => x.frame <= upToFrame);
		if (!update) update = this.createInitialUpdate(entity);
		if (entity.restartable && update.frame < this.lastRestartFrame) {
			update = this.createInitialUpdate(entity);
			update.frame = this.lastRestartFrame;
		}

		return update;
	}

	rollBackToFrame(target: number) {
		if (target === this.frame) return;
		this.frame = target;

		while (this.affectionGraph.length > 0 && Util.last(this.affectionGraph).frame > target)
			this.affectionGraph.pop();

		let helpMessages = G.menu.hud.alerts;
		while (helpMessages.length > 0 && Util.last(helpMessages).frame > target)
			helpMessages.pop();

		let alerts = G.menu.hud.alerts;
		while (alerts.length > 0 && Util.last(alerts).frame > target)
			alerts.pop();

		for (let [entityId, history] of this.internalStateHistory) {
			let popped = false;
			while (history.length > 0 && Util.last(history).frame > target) {
				history.pop();
				popped = true;
			}
			if (!popped) continue;

			let entity = this.game.getEntityById(entityId);
			let last = Util.last(history);
			entity.loadInternalState(last.state, last.frame);
		}

		for (let [entityId] of this.stateHistory) {
			this.rollBackEntityToFrame(this.game.getEntityById(entityId), target);
		}

		this.saveStates();
	}

	rollBackEntityToFrame(entity: Entity, frame: number) {
		let history = this.stateHistory.get(entity.id);

		let popped = false;
		while (Util.last(history) && Util.last(history).frame > frame) {
			history.pop();
			popped = true;
		}

		if (!popped) return;

		let update = this.getLastEntityUpdate(entity, frame);
		let state = update.state ?? entity.getInitialState();
		if (!state) return;

		entity.loadState(state, {
			frame: update.frame,
			remote: false
		});
	}

	createInitialUpdate(entity: Entity): EntityUpdate {
		return {
			updateId: -1,
			entityId: entity.id,
			frame: 0,
			state: null
		};
	}

	getHuntPoints() {
		let points = new DefaultMap<Marble, number>(() => 0);
		if (this.game.mode !== GameMode.Hunt) return points;

		for (let gem of this.game.shapes) {
			if (!(gem instanceof Gem)) continue;
			for (let marble of gem.pickUpHistory)
				points.set(marble, points.get(marble) + gem.pointValue);
		}

		return points;
	}
}