/* FIELD drawing input. The canvas should have a CSS width and height. */
(function () {
  'use strict';

  function mount(canvas, options = {}) {
    if (!canvas || typeof canvas.getContext !== 'function') {
      throw new TypeError('FieldDrawing.mount requires a canvas.');
    }

    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas drawing is unavailable.');
    if (options.initialDataUrl && !/^data:image\/png[;,]/i.test(options.initialDataUrl)) {
      throw new TypeError('The initial drawing must be a PNG data URL.');
    }

    const initialBounds = canvas.getBoundingClientRect();
    const worldWidth = Math.max(1, canvas.clientWidth || initialBounds.width || 600);
    const worldHeight = Math.max(1, canvas.clientHeight || initialBounds.height || 320);
    const previousTouchAction = canvas.style.touchAction;
    canvas.style.touchAction = 'none';

    const history = [];
    let color = options.color || '#20231e';
    let lineWidth = validWidth(options.lineWidth ?? 2);
    let pointerId = null;
    let activeStroke = null;
    let destroyed = false;
    let initialImagePending = false;
    let initialImage = null;
    let view = { width: worldWidth, height: worldHeight, scale: 1, x: 0, y: 0 };

    function validWidth(value) {
      const number = Number(value);
      return Number.isFinite(number) ? Math.max(0.5, Math.min(80, number)) : 2;
    }

    function visibleCommands() {
      let start = 0;
      for (let index = history.length - 1; index >= 0; index -= 1) {
        if (history[index].type === 'clear') {
          start = index + 1;
          break;
        }
      }
      return history.slice(start);
    }

    function hasContent() {
      return visibleCommands().some(command => command.type === 'image' ||
        (command.type === 'stroke' && command.points.length > 0));
    }

    function changed() {
      if (typeof options.onChange === 'function') options.onChange(hasContent());
    }

    function updateSize() {
      const bounds = canvas.getBoundingClientRect();
      const width = Math.max(1, canvas.clientWidth || bounds.width || worldWidth);
      const height = Math.max(1, canvas.clientHeight || bounds.height || worldHeight);
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const physicalWidth = Math.max(1, Math.round(width * dpr));
      const physicalHeight = Math.max(1, Math.round(height * dpr));
      if (canvas.width !== physicalWidth) canvas.width = physicalWidth;
      if (canvas.height !== physicalHeight) canvas.height = physicalHeight;
      const scale = Math.min(width / worldWidth, height / worldHeight);
      view = {
        width,
        height,
        scale,
        x: (width - worldWidth * scale) / 2,
        y: (height - worldHeight * scale) / 2
      };
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function render() {
      if (destroyed) return;
      updateSize();
      context.clearRect(0, 0, view.width, view.height);
      context.save();
      context.translate(view.x, view.y);
      context.scale(view.scale, view.scale);
      context.beginPath();
      context.rect(0, 0, worldWidth, worldHeight);
      context.clip();

      for (const command of visibleCommands()) {
        if (command.type === 'image') {
          const image = command.image;
          if (!image.complete || !image.naturalWidth) continue;
          const scale = Math.min(worldWidth / image.naturalWidth, worldHeight / image.naturalHeight);
          const width = image.naturalWidth * scale;
          const height = image.naturalHeight * scale;
          context.drawImage(image, (worldWidth - width) / 2, (worldHeight - height) / 2, width, height);
          continue;
        }

        if (command.type !== 'stroke' || command.points.length === 0) continue;
        const points = command.points;
        context.strokeStyle = command.color;
        context.fillStyle = command.color;
        context.lineWidth = command.width;
        context.lineCap = 'round';
        context.lineJoin = 'round';
        context.beginPath();
        if (points.length === 1) {
          context.arc(points[0].x, points[0].y, command.width / 2, 0, Math.PI * 2);
          context.fill();
        } else {
          context.moveTo(points[0].x, points[0].y);
          for (let index = 1; index < points.length; index += 1) {
            context.lineTo(points[index].x, points[index].y);
          }
          context.stroke();
        }
      }
      context.restore();
    }

    function pointFor(event) {
      const bounds = canvas.getBoundingClientRect();
      // Account for a CSS transform on the canvas or one of its ancestors.
      const cssX = (event.clientX - bounds.left) * view.width / (bounds.width || view.width);
      const cssY = (event.clientY - bounds.top) * view.height / (bounds.height || view.height);
      const x = (cssX - view.x) / view.scale;
      const y = (cssY - view.y) / view.scale;
      return {
        x: Math.max(0, Math.min(worldWidth, x)),
        y: Math.max(0, Math.min(worldHeight, y)),
        inside: x >= 0 && y >= 0 && x <= worldWidth && y <= worldHeight
      };
    }

    function finishStroke() {
      const id = pointerId;
      pointerId = null;
      activeStroke = null;
      if (id !== null && canvas.hasPointerCapture?.(id)) {
        canvas.releasePointerCapture(id);
      }
    }

    function pointerDown(event) {
      if (destroyed || initialImagePending || pointerId !== null || event.isPrimary === false || event.button !== 0) return;
      const point = pointFor(event);
      if (!point.inside) return;
      event.preventDefault();
      pointerId = event.pointerId;
      activeStroke = { type: 'stroke', color, width: lineWidth, points: [{ x: point.x, y: point.y }] };
      history.push(activeStroke);
      canvas.setPointerCapture?.(pointerId);
      render();
      changed();
    }

    function pointerMove(event) {
      if (destroyed || event.pointerId !== pointerId || !activeStroke) return;
      event.preventDefault();
      const events = event.getCoalescedEvents?.();
      for (const sample of events?.length ? events : [event]) {
        const point = pointFor(sample);
        const previous = activeStroke.points[activeStroke.points.length - 1];
        if (Math.hypot(point.x - previous.x, point.y - previous.y) >= 0.25) {
          activeStroke.points.push({ x: point.x, y: point.y });
        }
      }
      render();
    }

    function pointerUp(event) {
      if (event.pointerId !== pointerId) return;
      pointerMove(event);
      finishStroke();
      changed();
    }

    function lostCapture(event) {
      if (event.pointerId !== pointerId) return;
      pointerId = null;
      activeStroke = null;
      changed();
    }

    function pointerCancel(event) {
      if (event.pointerId !== pointerId) return;
      finishStroke();
      changed();
    }

    canvas.addEventListener('pointerdown', pointerDown);
    canvas.addEventListener('pointermove', pointerMove);
    canvas.addEventListener('pointerup', pointerUp);
    canvas.addEventListener('pointercancel', pointerCancel);
    canvas.addEventListener('lostpointercapture', lostCapture);

    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(render) : null;
    observer?.observe(canvas);
    window.addEventListener('resize', render);

    if (options.initialDataUrl) {
      initialImagePending = true;
      initialImage = new Image();
      const command = { type: 'image', image: initialImage, dataUrl: options.initialDataUrl };
      history.push(command);
      initialImage.onload = function () {
        if (destroyed) return;
        initialImagePending = false;
        render();
        changed();
      };
      initialImage.onerror = function () {
        if (destroyed) return;
        initialImagePending = false;
        const index = history.indexOf(command);
        if (index !== -1) history.splice(index, 1);
        render();
        changed();
      };
      initialImage.src = options.initialDataUrl;
    }

    render();

    return {
      clear() {
        if (destroyed || !hasContent()) return;
        finishStroke();
        history.push({ type: 'clear' });
        render();
        changed();
      },
      undo() {
        if (destroyed || history.length === 0) return;
        finishStroke();
        history.pop();
        render();
        changed();
      },
      setColor(value) {
        if (destroyed || typeof value !== 'string') return;
        const validator = document.createElement('span').style;
        validator.color = value;
        if (validator.color) color = value;
      },
      setLineWidth(value) {
        if (!destroyed) lineWidth = validWidth(value);
      },
      toDataURL() {
        if (destroyed) throw new Error('This drawing pad has been destroyed.');
        const visible = visibleCommands();
        if (initialImagePending && visible.length === 1 && visible[0].type === 'image') {
          return visible[0].dataUrl;
        }
        render();
        return canvas.toDataURL('image/png');
      },
      hasContent,
      destroy() {
        if (destroyed) return;
        finishStroke();
        destroyed = true;
        observer?.disconnect();
        window.removeEventListener('resize', render);
        canvas.removeEventListener('pointerdown', pointerDown);
        canvas.removeEventListener('pointermove', pointerMove);
        canvas.removeEventListener('pointerup', pointerUp);
        canvas.removeEventListener('pointercancel', pointerCancel);
        canvas.removeEventListener('lostpointercapture', lostCapture);
        canvas.style.touchAction = previousTouchAction;
        if (initialImage) {
          initialImage.onload = null;
          initialImage.onerror = null;
        }
      }
    };
  }

  window.FieldDrawing = { mount };
})();
