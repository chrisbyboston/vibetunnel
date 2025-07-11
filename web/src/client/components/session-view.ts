/**
 * Session View Component
 *
 * Full-screen terminal view for an active session. Handles terminal I/O,
 * streaming updates via SSE, file browser integration, and mobile overlays.
 *
 * @fires navigate-to-list - When navigating back to session list
 * @fires error - When an error occurs (detail: string)
 * @fires warning - When a warning occurs (detail: string)
 *
 * @listens session-exit - From SSE stream when session exits
 * @listens terminal-ready - From terminal component when ready
 * @listens file-selected - From file browser when file is selected
 * @listens browser-cancel - From file browser when cancelled
 */
import { html, LitElement, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { Session } from './session-list.js';
import './terminal.js';
import './file-browser.js';
import './clickable-path.js';
import './terminal-quick-keys.js';
import './session-view/mobile-input-overlay.js';
import './session-view/ctrl-alpha-overlay.js';
import './session-view/width-selector.js';
import './session-view/session-header.js';
import { createLogger } from '../utils/logger.js';
import {
  COMMON_TERMINAL_WIDTHS,
  TerminalPreferencesManager,
} from '../utils/terminal-preferences.js';
import { ConnectionManager } from './session-view/connection-manager.js';
import {
  type DirectKeyboardCallbacks,
  DirectKeyboardManager,
} from './session-view/direct-keyboard-manager.js';
import { InputManager } from './session-view/input-manager.js';
import type { LifecycleEventManagerCallbacks } from './session-view/interfaces.js';
import { LifecycleEventManager } from './session-view/lifecycle-event-manager.js';
import { LoadingAnimationManager } from './session-view/loading-animation-manager.js';
import { MobileInputManager } from './session-view/mobile-input-manager.js';
import {
  type TerminalEventHandlers,
  TerminalLifecycleManager,
  type TerminalStateCallbacks,
} from './session-view/terminal-lifecycle-manager.js';
import type { Terminal } from './terminal.js';

const logger = createLogger('session-view');

@customElement('session-view')
export class SessionView extends LitElement {
  // Disable shadow DOM to use Tailwind
  createRenderRoot() {
    return this;
  }

  @property({ type: Object }) session: Session | null = null;
  @property({ type: Boolean }) showBackButton = true;
  @property({ type: Boolean }) showSidebarToggle = false;
  @property({ type: Boolean }) sidebarCollapsed = false;
  @property({ type: Boolean }) disableFocusManagement = false;
  @state() private connected = false;
  @state() private showMobileInput = false;
  @state() private mobileInputText = '';
  @state() private isMobile = false;
  @state() private touchStartX = 0;
  @state() private touchStartY = 0;
  @state() private terminalCols = 0;
  @state() private terminalRows = 0;
  @state() private showCtrlAlpha = false;
  @state() private terminalFitHorizontally = false;
  @state() private terminalMaxCols = 0;
  @state() private showWidthSelector = false;
  @state() private customWidth = '';
  @state() private showFileBrowser = false;
  @state() private terminalFontSize = 14;
  @state() private terminalContainerHeight = '100%';

  private preferencesManager = TerminalPreferencesManager.getInstance();
  private connectionManager!: ConnectionManager;
  private inputManager!: InputManager;
  private mobileInputManager!: MobileInputManager;
  private directKeyboardManager!: DirectKeyboardManager;
  private terminalLifecycleManager!: TerminalLifecycleManager;
  private lifecycleEventManager!: LifecycleEventManager;
  private loadingAnimationManager = new LoadingAnimationManager();
  @state() private ctrlSequence: string[] = [];
  @state() private useDirectKeyboard = false;
  @state() private showQuickKeys = false;
  @state() private keyboardHeight = 0;

  private instanceId = `session-view-${Math.random().toString(36).substr(2, 9)}`;
  private createHiddenInputTimeout: ReturnType<typeof setTimeout> | null = null;

  // Removed methods that are now in LifecycleEventManager:
  // - handlePreferencesChanged
  // - keyboardHandler
  // - touchStartHandler
  // - touchEndHandler
  // - handleClickOutside

  private createLifecycleEventManagerCallbacks(): LifecycleEventManagerCallbacks {
    return {
      requestUpdate: () => this.requestUpdate(),
      handleBack: () => this.handleBack(),
      handleKeyboardInput: (e: KeyboardEvent) => this.handleKeyboardInput(e),
      getIsMobile: () => this.isMobile,
      setIsMobile: (value: boolean) => {
        this.isMobile = value;
      },
      getUseDirectKeyboard: () => this.useDirectKeyboard,
      setUseDirectKeyboard: (value: boolean) => {
        this.useDirectKeyboard = value;
      },
      getDirectKeyboardManager: () => ({
        getShowQuickKeys: () => this.directKeyboardManager.getShowQuickKeys(),
        setShowQuickKeys: (value: boolean) => this.directKeyboardManager.setShowQuickKeys(value),
        ensureHiddenInputVisible: () => this.directKeyboardManager.ensureHiddenInputVisible(),
        cleanup: () => this.directKeyboardManager.cleanup(),
      }),
      setShowQuickKeys: (value: boolean) => {
        this.showQuickKeys = value;
        this.updateTerminalTransform();
      },
      setShowFileBrowser: (value: boolean) => {
        this.showFileBrowser = value;
      },
      getInputManager: () => this.inputManager,
      getShowWidthSelector: () => this.showWidthSelector,
      setShowWidthSelector: (value: boolean) => {
        this.showWidthSelector = value;
      },
      setCustomWidth: (value: string) => {
        this.customWidth = value;
      },
      querySelector: (selector: string) => this.querySelector(selector),
      setTabIndex: (value: number) => {
        this.tabIndex = value;
      },
      addEventListener: (event: string, handler: EventListener) =>
        this.addEventListener(event, handler),
      removeEventListener: (event: string, handler: EventListener) =>
        this.removeEventListener(event, handler),
      focus: () => this.focus(),
      getDisableFocusManagement: () => this.disableFocusManagement,
      startLoading: () => this.loadingAnimationManager.startLoading(() => this.requestUpdate()),
      stopLoading: () => this.loadingAnimationManager.stopLoading(),
      setKeyboardHeight: (value: number) => {
        this.keyboardHeight = value;
        this.updateTerminalTransform();
      },
      getTerminalLifecycleManager: () =>
        this.terminalLifecycleManager
          ? {
              resetTerminalSize: () => this.terminalLifecycleManager.resetTerminalSize(),
              cleanup: () => this.terminalLifecycleManager.cleanup(),
            }
          : null,
      getConnectionManager: () =>
        this.connectionManager
          ? {
              setConnected: (connected: boolean) => this.connectionManager.setConnected(connected),
              cleanupStreamConnection: () => this.connectionManager.cleanupStreamConnection(),
            }
          : null,
      setConnected: (connected: boolean) => {
        this.connected = connected;
      },
    };
  }

  connectedCallback() {
    super.connectedCallback();
    this.connected = true;

    // Initialize connection manager
    this.connectionManager = new ConnectionManager(
      (sessionId: string) => {
        // Handle session exit
        if (this.session && sessionId === this.session.id) {
          this.session = { ...this.session, status: 'exited' };
          this.requestUpdate();
        }
      },
      (session: Session) => {
        // Handle session update
        this.session = session;
        this.requestUpdate();
      }
    );
    this.connectionManager.setConnected(true);

    // Initialize input manager
    this.inputManager = new InputManager();
    this.inputManager.setCallbacks({
      requestUpdate: () => this.requestUpdate(),
    });

    // Initialize mobile input manager
    this.mobileInputManager = new MobileInputManager(this);
    this.mobileInputManager.setInputManager(this.inputManager);

    // Initialize direct keyboard manager
    this.directKeyboardManager = new DirectKeyboardManager(this.instanceId);
    this.directKeyboardManager.setInputManager(this.inputManager);
    this.directKeyboardManager.setSessionViewElement(this);

    // Set up callbacks for direct keyboard manager
    const directKeyboardCallbacks: DirectKeyboardCallbacks = {
      getShowMobileInput: () => this.showMobileInput,
      getShowCtrlAlpha: () => this.showCtrlAlpha,
      getDisableFocusManagement: () => this.disableFocusManagement,
      getVisualViewportHandler: () => {
        // Trigger the visual viewport handler if it exists
        if (this.lifecycleEventManager && window.visualViewport) {
          // Manually trigger keyboard height calculation
          const viewport = window.visualViewport;
          const keyboardHeight = window.innerHeight - viewport.height;
          this.keyboardHeight = keyboardHeight;

          // Update quick keys component if it exists
          const quickKeys = this.querySelector('terminal-quick-keys') as HTMLElement & {
            keyboardHeight: number;
          };
          if (quickKeys) {
            quickKeys.keyboardHeight = keyboardHeight;
          }

          logger.log(`Visual Viewport keyboard height (manual trigger): ${keyboardHeight}px`);

          // Return a function that can be called to trigger the calculation
          return () => {
            if (window.visualViewport) {
              const currentHeight = window.innerHeight - window.visualViewport.height;
              this.keyboardHeight = currentHeight;
              if (quickKeys) {
                quickKeys.keyboardHeight = currentHeight;
              }
            }
          };
        }
        return null;
      },
      getKeyboardHeight: () => this.keyboardHeight,
      setKeyboardHeight: (height: number) => {
        this.keyboardHeight = height;
        this.updateTerminalTransform();
        this.requestUpdate();
      },
      updateShowQuickKeys: (value: boolean) => {
        this.showQuickKeys = value;
        this.requestUpdate();
        // Update terminal transform when quick keys visibility changes
        this.updateTerminalTransform();
      },
      toggleMobileInput: () => {
        this.showMobileInput = !this.showMobileInput;
        this.requestUpdate();
      },
      clearMobileInputText: () => {
        this.mobileInputText = '';
        this.requestUpdate();
      },
      toggleCtrlAlpha: () => {
        this.showCtrlAlpha = !this.showCtrlAlpha;
        this.requestUpdate();
      },
      clearCtrlSequence: () => {
        this.ctrlSequence = [];
        this.requestUpdate();
      },
    };
    this.directKeyboardManager.setCallbacks(directKeyboardCallbacks);

    // Initialize terminal lifecycle manager
    this.terminalLifecycleManager = new TerminalLifecycleManager();
    this.terminalLifecycleManager.setConnectionManager(this.connectionManager);
    this.terminalLifecycleManager.setInputManager(this.inputManager);
    this.terminalLifecycleManager.setConnected(this.connected);
    this.terminalLifecycleManager.setDomElement(this);

    // Set up event handlers for terminal lifecycle manager
    const eventHandlers: TerminalEventHandlers = {
      handleSessionExit: this.handleSessionExit.bind(this),
      handleTerminalResize: this.terminalLifecycleManager.handleTerminalResize.bind(
        this.terminalLifecycleManager
      ),
      handleTerminalPaste: this.terminalLifecycleManager.handleTerminalPaste.bind(
        this.terminalLifecycleManager
      ),
    };
    this.terminalLifecycleManager.setEventHandlers(eventHandlers);

    // Set up state callbacks for terminal lifecycle manager
    const stateCallbacks: TerminalStateCallbacks = {
      updateTerminalDimensions: (cols: number, rows: number) => {
        this.terminalCols = cols;
        this.terminalRows = rows;
        this.requestUpdate();
      },
    };
    this.terminalLifecycleManager.setStateCallbacks(stateCallbacks);

    if (this.session) {
      this.inputManager.setSession(this.session);
      this.terminalLifecycleManager.setSession(this.session);
    }

    // Load terminal preferences
    this.terminalMaxCols = this.preferencesManager.getMaxCols();
    this.terminalFontSize = this.preferencesManager.getFontSize();
    this.terminalLifecycleManager.setTerminalFontSize(this.terminalFontSize);
    this.terminalLifecycleManager.setTerminalMaxCols(this.terminalMaxCols);

    // Initialize lifecycle event manager
    this.lifecycleEventManager = new LifecycleEventManager();
    this.lifecycleEventManager.setSessionViewElement(this);
    this.lifecycleEventManager.setCallbacks(this.createLifecycleEventManagerCallbacks());
    this.lifecycleEventManager.setSession(this.session);

    // Load direct keyboard preference (needed before lifecycle setup)
    try {
      const stored = localStorage.getItem('vibetunnel_app_preferences');
      if (stored) {
        const preferences = JSON.parse(stored);
        this.useDirectKeyboard = preferences.useDirectKeyboard ?? true; // Default to true for new users
      } else {
        this.useDirectKeyboard = true; // Default to true when no settings exist
      }
    } catch (error) {
      console.error('Failed to load app preferences', error);
      this.useDirectKeyboard = true; // Default to true on error
    }

    // Set up lifecycle (replaces the extracted lifecycle logic)
    this.lifecycleEventManager.setupLifecycle();
  }

  disconnectedCallback() {
    super.disconnectedCallback();

    // Clear any pending timeout
    if (this.createHiddenInputTimeout) {
      clearTimeout(this.createHiddenInputTimeout);
      this.createHiddenInputTimeout = null;
    }

    // Use lifecycle event manager for teardown
    if (this.lifecycleEventManager) {
      this.lifecycleEventManager.teardownLifecycle();
      this.lifecycleEventManager.cleanup();
    }

    // Clean up loading animation manager
    this.loadingAnimationManager.cleanup();
  }

  firstUpdated(changedProperties: PropertyValues) {
    super.firstUpdated(changedProperties);
    if (this.session) {
      this.loadingAnimationManager.stopLoading();
      this.terminalLifecycleManager.setupTerminal();
    }
  }

  updated(changedProperties: Map<string, unknown>) {
    super.updated(changedProperties);

    // If session changed, clean up old stream connection
    if (changedProperties.has('session')) {
      const oldSession = changedProperties.get('session') as Session | null;
      if (oldSession && oldSession.id !== this.session?.id) {
        logger.log('Session changed, cleaning up old stream connection');
        if (this.connectionManager) {
          this.connectionManager.cleanupStreamConnection();
        }
      }
      // Update input manager with new session
      if (this.inputManager) {
        this.inputManager.setSession(this.session);
      }
      // Update terminal lifecycle manager with new session
      if (this.terminalLifecycleManager) {
        this.terminalLifecycleManager.setSession(this.session);
      }
      // Update lifecycle event manager with new session
      if (this.lifecycleEventManager) {
        this.lifecycleEventManager.setSession(this.session);
      }
    }

    // Stop loading and create terminal when session becomes available
    if (
      changedProperties.has('session') &&
      this.session &&
      this.loadingAnimationManager.isLoading()
    ) {
      this.loadingAnimationManager.stopLoading();
      this.terminalLifecycleManager.setupTerminal();
    }

    // Initialize terminal after first render when terminal element exists
    if (
      !this.terminalLifecycleManager.getTerminal() &&
      this.session &&
      !this.loadingAnimationManager.isLoading() &&
      this.connected
    ) {
      const terminalElement = this.querySelector('vibe-terminal') as Terminal;
      if (terminalElement) {
        this.terminalLifecycleManager.initializeTerminal();
      }
    }

    // Create hidden input if direct keyboard is enabled on mobile
    if (
      this.isMobile &&
      this.useDirectKeyboard &&
      !this.directKeyboardManager.getShowQuickKeys() &&
      this.session &&
      !this.loadingAnimationManager.isLoading()
    ) {
      // Clear any existing timeout
      if (this.createHiddenInputTimeout) {
        clearTimeout(this.createHiddenInputTimeout);
      }

      // Delay creation to ensure terminal is rendered and DOM is stable
      const TERMINAL_RENDER_DELAY_MS = 100;
      this.createHiddenInputTimeout = setTimeout(() => {
        try {
          // Re-validate conditions in case component state changed during the delay
          if (
            this.isMobile &&
            this.useDirectKeyboard &&
            !this.directKeyboardManager.getShowQuickKeys() &&
            this.connected // Ensure component is still connected to DOM
          ) {
            this.directKeyboardManager.ensureHiddenInputVisible();
          }
        } catch (error) {
          logger.warn('Failed to create hidden input during setTimeout:', error);
        }
        // Clear the timeout reference after execution
        this.createHiddenInputTimeout = null;
      }, TERMINAL_RENDER_DELAY_MS);
    }
  }

  async handleKeyboardInput(e: KeyboardEvent) {
    if (!this.inputManager) return;

    await this.inputManager.handleKeyboardInput(e);

    // Check if session status needs updating after input attempt
    // The input manager will have attempted to send input and may have detected session exit
    if (this.session && this.session.status !== 'exited') {
      // InputManager doesn't directly update session status, so we don't need to handle that here
      // This is handled by the connection manager when it detects connection issues
    }
  }

  handleBack() {
    // Dispatch a custom event that the app can handle with view transitions
    this.dispatchEvent(
      new CustomEvent('navigate-to-list', {
        bubbles: true,
        composed: true,
      })
    );
  }

  private handleSidebarToggle() {
    // Dispatch event to toggle sidebar
    this.dispatchEvent(
      new CustomEvent('toggle-sidebar', {
        bubbles: true,
        composed: true,
      })
    );
  }

  private handleSessionExit(e: Event) {
    const customEvent = e as CustomEvent;
    logger.log('session exit event received', customEvent.detail);

    if (this.session && customEvent.detail.sessionId === this.session.id) {
      // Update session status to exited
      this.session = { ...this.session, status: 'exited' };
      this.requestUpdate();

      // Switch to snapshot mode - disconnect stream and load final snapshot
      if (this.connectionManager) {
        this.connectionManager.cleanupStreamConnection();
      }

      // Notify parent app that session status changed so it can refresh the session list
      this.dispatchEvent(
        new CustomEvent('session-status-changed', {
          detail: {
            sessionId: this.session.id,
            newStatus: 'exited',
            exitCode: customEvent.detail.exitCode,
          },
          bubbles: true,
        })
      );
    }
  }

  // Mobile input methods
  private handleMobileInputToggle() {
    this.mobileInputManager.handleMobileInputToggle();
  }

  // Helper methods for MobileInputManager
  shouldUseDirectKeyboard(): boolean {
    return this.useDirectKeyboard;
  }

  toggleMobileInputDisplay(): void {
    this.showMobileInput = !this.showMobileInput;
    if (!this.showMobileInput) {
      // Refresh terminal scroll position after closing mobile input
      this.refreshTerminalAfterMobileInput();
    }
  }

  getMobileInputText(): string {
    return this.mobileInputText;
  }

  clearMobileInputText(): void {
    this.mobileInputText = '';
  }

  closeMobileInput(): void {
    this.showMobileInput = false;
  }

  shouldRefocusHiddenInput(): boolean {
    return this.directKeyboardManager.shouldRefocusHiddenInput();
  }

  refocusHiddenInput(): void {
    this.directKeyboardManager.refocusHiddenInput();
  }

  startFocusRetention(): void {
    this.directKeyboardManager.startFocusRetentionPublic();
  }

  delayedRefocusHiddenInput(): void {
    this.directKeyboardManager.delayedRefocusHiddenInputPublic();
  }

  private async handleMobileInputSendOnly(text: string) {
    await this.mobileInputManager.handleMobileInputSendOnly(text);
  }

  private async handleMobileInputSend(text: string) {
    await this.mobileInputManager.handleMobileInputSend(text);
  }

  private handleMobileInputCancel() {
    this.mobileInputManager.handleMobileInputCancel();
  }

  private async handleSpecialKey(key: string) {
    if (this.inputManager) {
      await this.inputManager.sendInputText(key);
    }
  }

  private handleCtrlAlphaToggle() {
    this.showCtrlAlpha = !this.showCtrlAlpha;
  }

  private async handleCtrlKey(letter: string) {
    // Add to sequence instead of immediately sending
    this.ctrlSequence = [...this.ctrlSequence, letter];
    this.requestUpdate();
  }

  private async handleSendCtrlSequence() {
    // Send each ctrl key in sequence
    if (this.inputManager) {
      for (const letter of this.ctrlSequence) {
        const controlCode = String.fromCharCode(letter.charCodeAt(0) - 64);
        await this.inputManager.sendInputText(controlCode);
      }
    }
    // Clear sequence and close overlay
    this.ctrlSequence = [];
    this.showCtrlAlpha = false;
    this.requestUpdate();

    // Refocus the hidden input
    if (this.directKeyboardManager.shouldRefocusHiddenInput()) {
      this.directKeyboardManager.refocusHiddenInput();
    }
  }

  private handleClearCtrlSequence() {
    this.ctrlSequence = [];
    this.requestUpdate();
  }

  private handleCtrlAlphaCancel() {
    this.showCtrlAlpha = false;
    this.ctrlSequence = [];
    this.requestUpdate();

    // Refocus the hidden input
    if (this.directKeyboardManager.shouldRefocusHiddenInput()) {
      this.directKeyboardManager.refocusHiddenInput();
    }
  }

  private handleKeyboardButtonClick() {
    // Show quick keys immediately for visual feedback
    this.showQuickKeys = true;

    // Update terminal transform immediately
    this.updateTerminalTransform();

    // Focus the hidden input synchronously - critical for iOS Safari
    // Must be called directly in the click handler without any delays
    this.directKeyboardManager.focusHiddenInput();

    // Request update after all synchronous operations
    this.requestUpdate();
  }

  private handleTerminalFitToggle() {
    this.terminalFitHorizontally = !this.terminalFitHorizontally;
    // Find the terminal component and call its handleFitToggle method
    const terminal = this.querySelector('vibe-terminal') as HTMLElement & {
      handleFitToggle?: () => void;
    };
    if (terminal?.handleFitToggle) {
      // Use the terminal's own toggle method which handles scroll position correctly
      terminal.handleFitToggle();
    }
  }

  private handleMaxWidthToggle() {
    this.showWidthSelector = !this.showWidthSelector;
  }

  private handleWidthSelect(newMaxCols: number) {
    this.terminalMaxCols = newMaxCols;
    this.preferencesManager.setMaxCols(newMaxCols);
    this.showWidthSelector = false;

    // Update the terminal lifecycle manager
    this.terminalLifecycleManager.setTerminalMaxCols(newMaxCols);

    // Update the terminal component
    const terminal = this.querySelector('vibe-terminal') as Terminal;
    if (terminal) {
      terminal.maxCols = newMaxCols;
      // Trigger a resize to apply the new constraint
      terminal.requestUpdate();
    }
  }

  private getCurrentWidthLabel(): string {
    if (this.terminalMaxCols === 0) return '∞';
    const commonWidth = COMMON_TERMINAL_WIDTHS.find((w) => w.value === this.terminalMaxCols);
    return commonWidth ? commonWidth.label : this.terminalMaxCols.toString();
  }

  private handleFontSizeChange(newSize: number) {
    // Clamp to reasonable bounds
    const clampedSize = Math.max(8, Math.min(32, newSize));
    this.terminalFontSize = clampedSize;
    this.preferencesManager.setFontSize(clampedSize);

    // Update the terminal lifecycle manager
    this.terminalLifecycleManager.setTerminalFontSize(clampedSize);

    // Update the terminal component
    const terminal = this.querySelector('vibe-terminal') as Terminal;
    if (terminal) {
      terminal.fontSize = clampedSize;
      terminal.requestUpdate();
    }
  }

  private handleOpenFileBrowser() {
    this.showFileBrowser = true;
  }

  private handleCloseFileBrowser() {
    this.showFileBrowser = false;
  }

  private async handleInsertPath(event: CustomEvent) {
    const { path, type } = event.detail;
    if (!path || !this.session) return;

    // Escape the path for shell use (wrap in quotes if it contains spaces)
    const escapedPath = path.includes(' ') ? `"${path}"` : path;

    // Send the path to the terminal
    if (this.inputManager) {
      await this.inputManager.sendInputText(escapedPath);
    }

    logger.log(`inserted ${type} path into terminal: ${escapedPath}`);
  }

  focusHiddenInput() {
    // Delegate to the DirectKeyboardManager
    this.directKeyboardManager.focusHiddenInput();
  }

  private handleTerminalClick(e: Event) {
    if (this.isMobile && this.useDirectKeyboard) {
      // Prevent the event from bubbling and default action
      e.stopPropagation();
      e.preventDefault();

      // Don't do anything - the hidden input should handle all interactions
      // The click on the terminal is actually a click on the hidden input overlay
      return;
    }
  }

  private async handleTerminalInput(e: CustomEvent) {
    const { text } = e.detail;
    if (this.inputManager && text) {
      await this.inputManager.sendInputText(text);
    }
  }

  private updateTerminalTransform(): void {
    // Calculate height reduction for keyboard and quick keys
    let heightReduction = 0;

    if (this.showQuickKeys && this.isMobile) {
      // Quick keys height (approximately 140px based on CSS)
      // Add 10px buffer to ensure content is visible above quick keys
      const quickKeysHeight = 150;
      heightReduction += quickKeysHeight;
    }

    if (this.keyboardHeight > 0) {
      // Add small buffer for keyboard too
      heightReduction += this.keyboardHeight + 10;
    }

    // Calculate terminal container height
    if (heightReduction > 0) {
      // Use calc to subtract from full height (accounting for header)
      this.terminalContainerHeight = `calc(100% - ${heightReduction}px)`;
    } else {
      this.terminalContainerHeight = '100%';
    }

    // Log for debugging
    logger.log(
      `Terminal height updated: quickKeys=${this.showQuickKeys}, keyboardHeight=${this.keyboardHeight}, reduction=${heightReduction}px`
    );

    // Force immediate update to apply height change
    this.requestUpdate();

    // Always notify terminal to resize when there's a change
    // Use requestAnimationFrame to ensure DOM has updated
    requestAnimationFrame(() => {
      const terminal = this.querySelector('vibe-terminal') as Terminal;
      if (terminal) {
        // Notify terminal of size change
        const terminalElement = terminal as unknown as { fitTerminal?: () => void };
        if (typeof terminalElement.fitTerminal === 'function') {
          terminalElement.fitTerminal();
        }

        // If height was reduced, scroll to keep cursor visible
        if (heightReduction > 0) {
          // Small delay then scroll to bottom to keep cursor visible
          setTimeout(() => {
            terminal.scrollToBottom();
          }, 50);
        }
      }
    });
  }

  refreshTerminalAfterMobileInput() {
    // After closing mobile input, the viewport changes and the terminal
    // needs to recalculate its scroll position to avoid getting stuck
    const terminal = this.terminalLifecycleManager.getTerminal();
    if (!terminal) return;

    // Give the viewport time to settle after keyboard disappears
    setTimeout(() => {
      const currentTerminal = this.terminalLifecycleManager.getTerminal();
      if (currentTerminal) {
        // Force the terminal to recalculate its viewport dimensions and scroll boundaries
        // This fixes the issue where maxScrollPixels becomes incorrect after keyboard changes
        const terminalElement = currentTerminal as unknown as { fitTerminal?: () => void };
        if (typeof terminalElement.fitTerminal === 'function') {
          terminalElement.fitTerminal();
        }

        // Then scroll to bottom to fix the position
        currentTerminal.scrollToBottom();
      }
    }, 300); // Wait for viewport to settle
  }

  render() {
    if (!this.session) {
      return html`
        <div class="fixed inset-0 bg-dark-bg flex items-center justify-center">
          <div class="text-dark-text font-mono text-center">
            <div class="text-2xl mb-2">${this.loadingAnimationManager.getLoadingText()}</div>
            <div class="text-sm text-dark-text-muted">Waiting for session...</div>
          </div>
        </div>
      `;
    }

    return html`
      <style>
        session-view *,
        session-view *:focus,
        session-view *:focus-visible {
          outline: none !important;
          box-shadow: none !important;
        }
        session-view:focus {
          outline: 2px solid #00ff88 !important;
          outline-offset: -2px;
        }
      </style>
      <div
        class="flex flex-col bg-black font-mono relative"
        style="height: 100vh; height: 100dvh; outline: none !important; box-shadow: none !important;"
      >
        <!-- Session Header -->
        <session-header
          .session=${this.session}
          .showBackButton=${this.showBackButton}
          .showSidebarToggle=${this.showSidebarToggle}
          .sidebarCollapsed=${this.sidebarCollapsed}
          .terminalCols=${this.terminalCols}
          .terminalRows=${this.terminalRows}
          .terminalMaxCols=${this.terminalMaxCols}
          .terminalFontSize=${this.terminalFontSize}
          .customWidth=${this.customWidth}
          .showWidthSelector=${this.showWidthSelector}
          .onBack=${() => this.handleBack()}
          .onSidebarToggle=${() => this.handleSidebarToggle()}
          .onOpenFileBrowser=${() => this.handleOpenFileBrowser()}
          .onMaxWidthToggle=${() => this.handleMaxWidthToggle()}
          .onWidthSelect=${(width: number) => this.handleWidthSelect(width)}
          .onFontSizeChange=${(size: number) => this.handleFontSizeChange(size)}
          @close-width-selector=${() => {
            this.showWidthSelector = false;
            this.customWidth = '';
          }}
        ></session-header>

        <!-- Terminal Container -->
        <div
          class="${this.terminalContainerHeight === '100%' ? 'flex-1' : ''} bg-black overflow-hidden min-h-0 relative ${
            this.session?.status === 'exited' ? 'session-exited' : ''
          }"
          id="terminal-container"
          style="${this.terminalContainerHeight !== '100%' ? `height: ${this.terminalContainerHeight}; flex: none; max-height: ${this.terminalContainerHeight};` : ''} transition: height 0.3s ease-out;"
        >
          ${
            this.loadingAnimationManager.isLoading()
              ? html`
                <!-- Loading overlay -->
                <div
                  class="absolute inset-0 bg-dark-bg bg-opacity-80 flex items-center justify-center z-10"
                >
                  <div class="text-dark-text font-mono text-center">
                    <div class="text-2xl mb-2">${this.loadingAnimationManager.getLoadingText()}</div>
                    <div class="text-sm text-dark-text-muted">Connecting to session...</div>
                  </div>
                </div>
              `
              : ''
          }
          <!-- Terminal Component -->
          <vibe-terminal
            .sessionId=${this.session?.id || ''}
            .sessionStatus=${this.session?.status || 'running'}
            .cols=${80}
            .rows=${24}
            .fontSize=${this.terminalFontSize}
            .fitHorizontally=${false}
            .maxCols=${this.terminalMaxCols}
            .disableClick=${this.isMobile && this.useDirectKeyboard}
            .hideScrollButton=${this.showQuickKeys}
            class="w-full h-full p-0 m-0"
            @click=${this.handleTerminalClick}
            @terminal-input=${this.handleTerminalInput}
          ></vibe-terminal>
        </div>

        <!-- Floating Session Exited Banner (outside terminal container to avoid filter effects) -->
        ${
          this.session?.status === 'exited'
            ? html`
              <div
                class="fixed inset-0 flex items-center justify-center pointer-events-none z-[25]"
              >
                <div
                  class="bg-dark-bg-secondary border border-dark-border text-status-warning font-medium text-sm tracking-wide px-4 py-2 rounded-lg shadow-lg"
                >
                  SESSION EXITED
                </div>
              </div>
            `
            : ''
        }

        <!-- Mobile Input Controls (only show when direct keyboard is disabled) -->
        ${
          this.isMobile && !this.showMobileInput && !this.useDirectKeyboard
            ? html`
              <div class="flex-shrink-0 p-4" style="background: black;">
                <!-- First row: Arrow keys -->
                <div class="flex gap-2 mb-2">
                  <button
                    class="flex-1 font-mono px-3 py-2 text-sm transition-all cursor-pointer quick-start-btn"
                    @click=${() => this.handleSpecialKey('arrow_up')}
                  >
                    <span class="text-xl">↑</span>
                  </button>
                  <button
                    class="flex-1 font-mono px-3 py-2 text-sm transition-all cursor-pointer quick-start-btn"
                    @click=${() => this.handleSpecialKey('arrow_down')}
                  >
                    <span class="text-xl">↓</span>
                  </button>
                  <button
                    class="flex-1 font-mono px-3 py-2 text-sm transition-all cursor-pointer quick-start-btn"
                    @click=${() => this.handleSpecialKey('arrow_left')}
                  >
                    <span class="text-xl">←</span>
                  </button>
                  <button
                    class="flex-1 font-mono px-3 py-2 text-sm transition-all cursor-pointer quick-start-btn"
                    @click=${() => this.handleSpecialKey('arrow_right')}
                  >
                    <span class="text-xl">→</span>
                  </button>
                </div>

                <!-- Second row: Special keys -->
                <div class="flex gap-2">
                  <button
                    class="font-mono text-sm transition-all cursor-pointer w-16 quick-start-btn"
                    @click=${() => this.handleSpecialKey('escape')}
                  >
                    ESC
                  </button>
                  <button
                    class="font-mono text-sm transition-all cursor-pointer w-16 quick-start-btn"
                    @click=${() => this.handleSpecialKey('\t')}
                  >
                    <span class="text-xl">⇥</span>
                  </button>
                  <button
                    class="flex-1 font-mono px-3 py-2 text-sm transition-all cursor-pointer quick-start-btn"
                    @click=${this.handleMobileInputToggle}
                  >
                    ABC123
                  </button>
                  <button
                    class="font-mono text-sm transition-all cursor-pointer w-16 quick-start-btn"
                    @click=${this.handleCtrlAlphaToggle}
                  >
                    CTRL
                  </button>
                  <button
                    class="font-mono text-sm transition-all cursor-pointer w-16 quick-start-btn"
                    @click=${() => this.handleSpecialKey('enter')}
                  >
                    <span class="text-xl">⏎</span>
                  </button>
                </div>
              </div>
            `
            : ''
        }

        <!-- Mobile Input Overlay -->
        <mobile-input-overlay
          .visible=${this.isMobile && this.showMobileInput}
          .mobileInputText=${this.mobileInputText}
          .keyboardHeight=${this.keyboardHeight}
          .touchStartX=${this.touchStartX}
          .touchStartY=${this.touchStartY}
          .onSend=${(text: string) => this.handleMobileInputSendOnly(text)}
          .onSendWithEnter=${(text: string) => this.handleMobileInputSend(text)}
          .onCancel=${() => this.handleMobileInputCancel()}
          .onTextChange=${(text: string) => {
            this.mobileInputText = text;
          }}
          .handleBack=${this.handleBack.bind(this)}
        ></mobile-input-overlay>

        <!-- Ctrl+Alpha Overlay -->
        <ctrl-alpha-overlay
          .visible=${this.isMobile && this.showCtrlAlpha}
          .ctrlSequence=${this.ctrlSequence}
          .keyboardHeight=${this.keyboardHeight}
          .onCtrlKey=${(letter: string) => this.handleCtrlKey(letter)}
          .onSendSequence=${() => this.handleSendCtrlSequence()}
          .onClearSequence=${() => this.handleClearCtrlSequence()}
          .onCancel=${() => this.handleCtrlAlphaCancel()}
        ></ctrl-alpha-overlay>

        <!-- Floating Keyboard Button (for direct keyboard mode on mobile) -->
        ${
          this.isMobile && this.useDirectKeyboard && !this.showQuickKeys
            ? html`
              <div
                class="keyboard-button"
                @pointerdown=${(e: PointerEvent) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                @click=${(e: MouseEvent) => {
                  e.preventDefault();
                  e.stopPropagation();
                  this.handleKeyboardButtonClick();
                }}
                title="Show keyboard"
              >
                ⌨
              </div>
            `
            : ''
        }

        <!-- Terminal Quick Keys (for direct keyboard mode) -->
        <terminal-quick-keys
          .visible=${this.isMobile && this.useDirectKeyboard && this.showQuickKeys}
          .onKeyPress=${this.directKeyboardManager.handleQuickKeyPress}
        ></terminal-quick-keys>

        <!-- File Browser Modal -->
        <file-browser
          .visible=${this.showFileBrowser}
          .mode=${'browse'}
          .session=${this.session}
          @browser-cancel=${this.handleCloseFileBrowser}
          @insert-path=${this.handleInsertPath}
        ></file-browser>
      </div>
    `;
  }
}
