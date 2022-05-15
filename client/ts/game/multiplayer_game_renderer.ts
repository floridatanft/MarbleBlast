import { GAME_UPDATE_RATE } from "../../../shared/constants";
import { G } from "../global";
import { Vector2 } from "../math/vector2";
import { BallCollisionShape } from "../physics/collision_shape";
import { hudCtx } from "../ui/hud";
import { Util } from "../util";
import { GameRenderer } from "./game_renderer";
import { MultiplayerGame } from "./multiplayer_game";

const NAME_TAG_HEIGHT = 18;

export class MultiplayerGameRenderer extends GameRenderer {
	networkStatTimeout = 0;
	game: MultiplayerGame;

	renderHud() {
		super.renderHud();

		G.menu.hud.displayScoreboard();

		hudCtx.clearRect(0, 0, hudCtx.canvas.width, hudCtx.canvas.height);

		for (let marble of this.game.marbles) {
			if (!marble.addedToGame) continue;
			let player = marble.controllingPlayer;
			if (!player || player === this.game.localPlayer) continue;
			let socket = G.lobby.sockets.find(x => x.id === player.sessionId);
			if (!socket) continue;

			let pos = marble.group.position.clone().addScaledVector(this.camera.up, 0.5); // Use the visual position, not the physics one
			let projected = pos.clone().applyMatrix4(this.camera.matrixWorldInverse).applyMatrix4(this.camera.projectionMatrix);

			projected.addScalar(1).multiplyScalar(0.5);
			if (projected.z < 0 || projected.z > 1) continue; // Not inside the view frustum

			let hits = this.game.simulator.world.castRay(this.camera.position, marble.group.position.clone().sub(this.camera.position), 1);
			let inLineOfSight = !hits.some(x => !(x.shape instanceof BallCollisionShape));

			hudCtx.globalAlpha = inLineOfSight? 1 : 0.5;

			let screenPos = new Vector2(
				Math.floor(hudCtx.canvas.width * projected.x),
				Math.floor(hudCtx.canvas.height * (1 - projected.y))
			);

			hudCtx.textAlign = 'center';
			hudCtx.textBaseline = 'middle';
			hudCtx.font = '12px Nunito';

			let name = socket.name;
			let nameTagWidth = Util.roundToMultiple(hudCtx.measureText(name).width + 20, 2);

			hudCtx.fillStyle = 'rgba(0,0,0,0.333)';
			Util.roundRect(
				hudCtx,
				screenPos.x - nameTagWidth/2,
				screenPos.y - NAME_TAG_HEIGHT/2,
				nameTagWidth,
				NAME_TAG_HEIGHT,
				5
			);
			hudCtx.fill();

			hudCtx.fillStyle = 'black';
			hudCtx.fillText(name, screenPos.x + 1, screenPos.y + 1);
			hudCtx.fillStyle = 'white';
			hudCtx.fillText(name, screenPos.x, screenPos.y);
		}

		if (--this.networkStatTimeout <= 0) {
			this.displayNetworkStats();
			this.networkStatTimeout = 3;
		}
	}

	displayNetworkStats() {
		let { game } = this;

		if (!game.started) return;

		let now = performance.now();
		while (game.recentRtts.length > 0 && now - game.recentRtts[0].timestamp > 2000) game.recentRtts.shift();
		while (game.incomingTimes.length > 0 && now - game.incomingTimes[0][0] > 1000) game.incomingTimes.shift();
		while (game.outgoingTimes.length > 0 && now - game.outgoingTimes[0][0] > 1000) game.outgoingTimes.shift();

		while (game.tickDurations.length > 0 && now - game.tickDurations[0].start > 1000) game.tickDurations.shift();
		while (game.simulator.advanceTimes.length > 0 && now - game.simulator.advanceTimes[0] > 1000) game.simulator.advanceTimes.shift();
		while (game.simulator.reconciliationDurations.length > 0 && now - game.simulator.reconciliationDurations[0].start > 1000) game.simulator.reconciliationDurations.shift();

		//let medianRtt = Util.computeMedian(game.recentRtts.map(x => x.value));
		let averageRtt = game.recentRtts.map(x => x.value).reduce((a, b) => a + b, 0) / game.recentRtts.length;
		let jitter = game.recentRtts.map(x => Math.abs(x.value - averageRtt)).reduce((a, b) => a + b, 0) / game.recentRtts.length;
		let averageTickDuration = game.tickDurations.map(x => x.duration).reduce((a, b) => a + b, 0) / game.tickDurations.length;
		let averageReconciliationDuration = game.simulator.reconciliationDurations.map(x => x.duration).reduce((a, b) => a + b, 0) / game.simulator.reconciliationDurations.length;

		G.menu.hud.networkStats.textContent = `
			Ping: ${isNaN(averageRtt)? 'N/A' : averageRtt.toFixed(1) + ' ms'}
			Jitter: ${isNaN(jitter)? 'N/A' : jitter.toFixed(1) + ' ms'}
			Incoming packets/s: ${game.incomingTimes.length}
			Outgoing packets/s: ${game.outgoingTimes.length}
			Downstream: ${(game.incomingTimes.map(x => x[1]).reduce((a, b) => a + b, 0) / 1000).toFixed(1)} kB/s
			Upstream: ${(game.outgoingTimes.map(x => x[1]).reduce((a, b) => a + b, 0) / 1000).toFixed(1)} kB/s
			Server frame: ${game.state.serverFrame}
			Client frame: ${game.state.frame}
			Target frame: ${game.state.targetFrame}
			Frames ahead server: ${game.state.frame - game.state.serverFrame}
			Frames ahead target: ${game.state.frame - game.state.targetFrame}
			Server update rate: ${GAME_UPDATE_RATE} Hz
			Client update rate: ${game.lastUpdateRate | 0} Hz
			Advancements/s: ${game.simulator.advanceTimes.length}
			Tick duration: ${averageTickDuration.toFixed(2)} ms
			Reconciliation duration: ${isNaN(averageReconciliationDuration)? 'N/A' : averageReconciliationDuration.toFixed(2) + ' ms'}
			Reconciliation frames: ${game.simulator.lastReconciliationFrames}
			Send timeout: idk
		`;

		//document.body.style.filter = sendTimeout <= 0 ? '' : 'saturate(0.25)';
	}
}